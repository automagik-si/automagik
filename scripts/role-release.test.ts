import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KEY_ID } from './lane';

const ROOT = join(import.meta.dir, '..');
const PLUGIN = 'apps/bots-dsh';
const REPO = 'fixture/repository';
const CUT = '3.160.30';
const EARLIER = '3.160.9';
const PREVIOUS = '3.160.10';
const ID = 'voice-mouth';
const PAIR = ['roles.json', 'roles.json.sig'];
const tarball = (version: string) => 'automagik-role-' + ID + '-' + version + '.tgz';
type RoleRow = { id: string; version: string; sha256: string; source: string };
const catalogRole = (catalog: { roles: RoleRow[] }, id = ID) => catalog.roles.find(row => row.id === id)!;
type Step = { name: string; if?: string; env?: Record<string, string>; run: string };
type Workflow = {
  on: Record<string, { inputs: Record<string, { type: string; default: boolean }> }>;
  jobs: Record<string, { steps: Step[] }>;
};
const readWorkflow = (file: string) =>
  Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows', file + '.yml'), 'utf8')) as Workflow;
const workflow = readWorkflow('release');
const steps = workflow.jobs.cut.steps;
const step = (name: string) => steps.find(step => step.name === name)!;
const PACK = step('Pack the roles');
const WRITE = step('Write the role catalog');
const SIGN = step('Sign the role catalog');
const CHECK = step('Check the role catalog');
const PUBLISH = step('Publish the release');
const SWEEP = Object.values(readWorkflow('desktop-build').jobs).flatMap(job => job.steps ?? [])
  .find(step => step.name === 'Add the builds to the release')!;
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const chain = (...steps: Step[]) => steps.map(step => '(\n' + step.run + '\n)').join('\n');

function listing(tag: string, assets = PAIR, options = {}) {
  return { tag_name: 'v' + tag, draft: false, prerelease: false, assets: assets.map(name => ({ name, size: 1024 })), ...options };
}

function fixture(extraRole?: string) {
  const root = mkdtempSync(join(tmpdir(), 'role-release-'));
  const put = (file: string, bytes: string | Buffer, mode?: number) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes, { mode });
  };
  for (const file of [
    'scripts/lane.ts', 'scripts/role-pack.ts', 'scripts/version.ts', 'am/part.json', 'meter/usagemeter/part.json',
    PLUGIN + '/package.json', PLUGIN + '/roles',
    ...['role-catalog.js', 'role-keys.json', 'role-package.js', 'role-tar.js', 'refusal.js', 'bounded-get.js', 'no-runner.js', 'bundled-roles.js', 'bundled-roles.json', 'lane-verify.js'].map(file => PLUGIN + '/src/host/' + file),
    PLUGIN + '/src/shared/roles.js', PLUGIN + '/src/shared/solver-method.js',
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file), { recursive: true });
  }
  let sourceSha = sha;
  if (extraRole) {
    const roles = join(root, PLUGIN, 'roles');
    cpSync(join(roles, ID), join(roles, extraRole), { recursive: true, errorOnExist: true, force: false });
    const manifest = join(roles, extraRole, 'role.json');
    writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), id: extraRole }));
    git(root, 'init', '-q');
    git(root, 'add', '--', PLUGIN + '/roles');
    git(root, 'commit', '-qm', 'multiple role sources');
    sourceSha = git(root, 'rev-parse', 'HEAD');
  }
  const keys = generateKeyPairSync('ed25519');
  const key = { keyId: KEY_ID, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  put('plugin-lane/keys.json', JSON.stringify({ keys: [key] }));
  put('listing.json', '[[]]');
  const fake = (command: string, script: string) => put('bin/' + command, '#!/usr/bin/env bash\nset -euo pipefail\n' + script + '\n', 0o700);
  fake('git', String.raw`
[[ ! -v PLUGIN_LANE_KEY ]]
case "$1" in
  rev-parse) [[ "$*" == 'rev-parse HEAD' ]]; printf '%s\n' "$SHA" ;;
  ls-tree) [[ "$5" == "$SHA" ]]; set -- "$1" "$2" "$3" "$4" "$REAL_SHA" "$6" "$7"
           exec "$REAL_GIT" -C "$REAL_ROOT" "$@" ;;
  cat-file) exec "$REAL_GIT" -C "$REAL_ROOT" "$@" ;;
  show) [[ "$TZ" == UTC && "$5" == "$SHA" ]]; printf '%s\n' '2026-11-20T03:00:00Z' ;;
  merge-base) [[ "$2" == --is-ancestor && "$4" == "$SHA" ]]
              printf '%s %s\n' "$3" "$4" >> ancestry.log
              if [[ -n "$ANCESTRY_REPO" ]]; then exec "$REAL_GIT" -C "$ANCESTRY_REPO" "$@"; fi ;;
  *) exit 64 ;;
esac
`);
  fake('gh', String.raw`
[[ ! -v PLUGIN_LANE_KEY ]]
printf '%s\n' "$*" >> gh.log
case "$1 $2" in
  'api --paginate')
    [[ "$*" == "api --paginate --slurp repos/$GITHUB_REPOSITORY/releases?per_page=100" ]]
    [[ "$GH_TOKEN" == fixture-token ]]
    [[ "$HISTORY_READ" != fail ]] || exit 8
    cat listing.json ;;
  'release download')
    if [[ "$*" == *PLUGINS.SHA256SUMS* ]]; then exit 0; fi
    [[ "$4 $5 $6 $7 $8 $9" == "--repo $GITHUB_REPOSITORY -p roles.json -p roles.json.sig" ]] || exit 64
    [[ "$HISTORY_READ" != download-failed ]] || exit 8
    tag=$3
    shift 9
    [[ "$1" == --dir && "$2" != "$PWD/release" ]]
    cp "history/$tag/roles.json" "history/$tag/roles.json.sig" "$2" ;;
  'release create'|'release delete-asset'|'release upload'|'release edit') ;;
  'release view') cat desktop-assets.txt ;;
  *) exit 64 ;;
esac
`);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  if (!realGit.startsWith('/')) throw new Error('fixture needs an absolute git path');
  const env = {
    ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
    REAL_ROOT: extraRole ? root : ROOT, REAL_SHA: sourceSha, REAL_GIT: realGit, GH_TOKEN: 'fixture-token', GITHUB_REPOSITORY: REPO,
    VERSION: CUT, SHA: sha, GITHUB_OUTPUT: join(root, 'output'), RESTAMP_ROLES: 'false', HISTORY_READ: 'ok',
    KIND: 'plugins', HERDR: 'no', POCKET: 'no', METER: 'no', PRERELEASE: 'false', REPLACE: 'false', ANCESTRY_REPO: '',
  };
  delete (env as Record<string, string | undefined>).PLUGIN_LANE_KEY;
  function run(script: string, overrides: Record<string, string> = {}) {
    return spawnSync('bash', ['-euo', 'pipefail', '-c', script], { cwd: root, env: { ...env, ...overrides }, encoding: 'utf8' });
  }
  function success(script: string, overrides: Record<string, string> = {}) {
    const result = run(script, overrides);
    if (result.status !== 0) throw new Error(result.stderr || String(result.error ?? result.status));
    return result.stdout;
  }
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const calls = () => existsSync(join(root, 'gh.log')) ? read('gh.log').trimEnd().split('\n') : [];
  const setListing = (...pages: ReturnType<typeof listing>[][]) => put('listing.json', JSON.stringify(pages));
  const clean = () => rmSync(root, { recursive: true, force: true });
  function clearStage() {
    for (const file of ['release', 'gh.log', 'ancestry.log']) rmSync(join(root, file), { recursive: true, force: true });
    put('release/plugins.json', '{}');
  }
  function signHistory(version: string, bytes: string, invalid = false) {
    const detached = sign(null, Buffer.from(bytes), invalid ? generateKeyPairSync('ed25519').privateKey : keys.privateKey);
    put('history/v' + version + '/roles.json', bytes);
    put('history/v' + version + '/roles.json.sig', detached.toString('base64') + '\n');
  }
  function makeHistory(version: string) {
    clearStage();
    success(chain(PACK, WRITE), { VERSION: version, RESTAMP_ROLES: 'true' });
    const bytes = read('release/roles.json');
    signHistory(version, bytes);
    clearStage();
    return JSON.parse(bytes);
  }
  clearStage();
  return { root, put, read, run, success, calls, setListing, clean, clearStage, signHistory, makeHistory, privateKey };
}

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
  ], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || String(result.status));
  return result.stdout.trim();
}

test('the cut packs roles only on plugin cuts and keeps the signing key on its two existing steps', () => {
  const names = ['Pack the plugins', PACK.name, WRITE.name, SIGN.name, CHECK.name, PUBLISH.name];
  expect(steps.map(step => step.name).filter(name => names.includes(name))).toEqual(names);
  expect(PACK.if).toBe(step('Pack the plugins').if);
  expect(PACK.env).toEqual({
    VERSION: '${{ steps.cut.outputs.version }}', SHA: '${{ steps.cut.outputs.sha }}',
    GH_TOKEN: '${{ github.token }}', GITHUB_REPOSITORY: '${{ github.repository }}', RESTAMP_ROLES: '${{ inputs.restamp_roles }}',
  });
  expect(steps.filter(step => step.env?.PLUGIN_LANE_KEY).map(step => step.name)).toEqual([SIGN.name, 'Sign and post the plugin lane']);
  for (const event of ['workflow_dispatch', 'workflow_call']) {
    expect(workflow.on[event].inputs.restamp_roles).toMatchObject({ type: 'boolean', default: false });
  }
  const allows = (kind: string, version = CUT) => {
    // The same step condition as GitHub, with just the two workflow outputs it reads.
    const condition = PACK.if!.replaceAll('steps.cut.outputs.version', 'version').replaceAll('steps.lane.outputs.kind', 'kind');
    return Function('kind', 'version', 'return ' + condition)(kind, version);
  };
  const release = fixture();
  try {
    for (const kind of ['am', 'herdr', 'pocket', 'meter']) expect(allows(kind)).toBe(false);
    expect(allows('plugins', '')).toBe(false);
    for (const [kind, prerelease] of [['plugins', 'false'], ['plugins', 'true'], ['full', 'false']]) {
      expect(allows(kind)).toBe(true);
      release.clearStage();
      release.success(PACK.run, { KIND: kind, PRERELEASE: prerelease });
      expect(readdirSync(join(release.root, 'release'))).toContain(tarball(CUT));
    }
  } finally { release.clean(); }
});

test('role catalog stages share the plugin guard and leave plugin checksums ahead of role artifacts', () => {
  const plugin = step('Pack the plugins');
  for (const stage of [PACK, WRITE, SIGN, CHECK]) expect(stage.if).toBe(plugin.if);
  expect(WRITE.env).toEqual({
    VERSION: '${{ steps.cut.outputs.version }}', SHA: '${{ steps.cut.outputs.sha }}',
  });
  expect(WRITE.run).toContain('bun scripts/lane.ts roles-manifest "${VERSION}" "${ISSUED}" release > release/roles.json');
  expect(plugin.run).toContain('sha256sum -- * > PLUGINS.SHA256SUMS');
  for (const stage of [PACK, WRITE, SIGN, CHECK]) expect(stage.run).not.toContain('PLUGINS.SHA256SUMS');
  const sweepLines = SWEEP.run.split('\n');
  const catalog = sweepLines.findIndex(line => line.includes('case "${name}" in roles.json|roles.json.sig) continue'));
  expect(catalog).toBeGreaterThanOrEqual(0);
  expect(sweepLines[catalog + 1]).toContain('case "${name}" in automagik-role-*.tgz.sha256) continue');
});

test('selects the newest reachable published catalog including prereleases and skips catalog-free lanes', () => {
  const extraRole = 'fixture-earlier-role';
  const release = fixture(extraRole);
  try {
    release.makeHistory(EARLIER);
    const prior = release.makeHistory(PREVIOUS);
    const priorVoice = catalogRole(prior);
    expect(prior.roles.indexOf(catalogRole(prior, extraRole))).toBeLessThan(prior.roles.indexOf(priorVoice));
    const patchLanes = ['herdr', 'pocket', 'am', 'meter'];
    const branchTag = '3.160.25';
    release.makeHistory(branchTag);
    const graph = join(release.root, 'graph');
    mkdirSync(graph);
    const graphGit = (...args: string[]) => git(graph, ...args);
    graphGit('init', '-q', '-b', 'dev');
    graphGit('commit', '--allow-empty', '-qm', 'previous publication');
    for (const version of [EARLIER, PREVIOUS, '3.160.20', '3.160.21', '3.160.22', '3.160.23']) graphGit('tag', 'v' + version);
    graphGit('switch', '-qc', 'other');
    graphGit('commit', '--allow-empty', '-qm', 'divergent publication');
    graphGit('tag', 'v' + branchTag);
    const otherSha = graphGit('rev-parse', 'HEAD');
    graphGit('switch', '-q', 'dev');
    graphGit('commit', '--allow-empty', '-qm', 'pushed tag with failed publish');
    for (const version of ['3.160.24', '3.160.26']) graphGit('tag', 'v' + version);
    graphGit('commit', '--allow-empty', '-qm', 'winning cut');
    const retrySha = graphGit('rev-parse', 'HEAD');
    release.setListing(
      [listing(branchTag), listing('3.160.24', PAIR, { draft: true }), listing('3.20261120.0'), listing(CUT)],
      [listing(EARLIER), ...patchLanes.map((kind, i) => listing('3.160.' + (20 + i), [kind + '.tgz']))],
      [listing(PREVIOUS, PAIR, { prerelease: true })],
    );
    release.success(chain(PACK, WRITE), { ANCESTRY_REPO: graph, SHA: otherSha });
    expect(catalogRole(JSON.parse(release.read('release/roles.json'))).version).toBe(branchTag);
    release.clearStage();
    release.success(chain(PACK, WRITE), { ANCESTRY_REPO: graph, SHA: retrySha });
    const output = JSON.parse(release.read('release/roles.json'));
    expect(output.version).toBe(CUT);
    expect(catalogRole(output)).toMatchObject({
      id: ID, version: PREVIOUS, sha256: priorVoice.sha256,
      source: priorVoice.source.replace('/v' + PREVIOUS + '/', '/v' + CUT + '/'),
    });
    expect(release.read('ancestry.log').trimEnd().split('\n')).toEqual([
      'refs/tags/v' + branchTag + ' ' + retrySha, 'refs/tags/v' + PREVIOUS + ' ' + retrySha,
    ]);
    expect(release.calls()).toHaveLength(2);
    expect(release.calls()[1]).toContain('release download v' + PREVIOUS);
  } finally { release.clean(); }
});

test('verified absence stamps the cut version, and a restamp bypasses history explicitly', () => {
  const release = fixture();
  try {
    release.makeHistory(PREVIOUS);
    release.setListing([listing(PREVIOUS, PAIR, { draft: true }), listing('3.20261120.0'), listing('3.160.27', ['am.tgz'])]);
    release.success(chain(PACK, WRITE));
    expect(catalogRole(JSON.parse(release.read('release/roles.json'))).version).toBe(CUT);
    expect(release.calls()).toHaveLength(1);
    release.clearStage();

    release.setListing([listing(PREVIOUS)]);
    const out = release.success(chain(PACK, WRITE), { RESTAMP_ROLES: 'true', HISTORY_READ: 'fail' });
    expect(out).toMatch(/::warning::restamp_roles/);
    expect(catalogRole(JSON.parse(release.read('release/roles.json'))).version).toBe(CUT);
    expect(release.calls()).toEqual([]);
  } finally { release.clean(); }
});

test('damaged history stops before Write or Publish, including correctly signed invalid rows', () => {
  const release = fixture();
  try {
    const base = release.makeHistory(PREVIOUS);
    const entry = catalogRole(base);
    const valid = JSON.stringify(base);
    const cut = chain(PACK, WRITE, PUBLISH);
    for (const [name, configure, pattern, overrides = {}] of [
      ['gh error', () => {}, /listing failed/, { HISTORY_READ: 'fail' }],
      ['bad JSON', () => release.put('listing.json', '{'), /invalid release listing/],
      ['empty response', () => release.put('listing.json', ''), /invalid release listing/],
      ['bad shape', () => release.put('listing.json', '[{}]'), /invalid release listing/],
      ['failed download', () => {}, /could not download/, { HISTORY_READ: 'download-failed' }],
      ['bad signature', () => release.signHistory(PREVIOUS, valid, true), /signature does not match/],
      ['wrong catalog version', () => release.signHistory(PREVIOUS, JSON.stringify({ ...base, version: EARLIER })), /catalog version does not match/],
      ['oversize', () => release.signHistory(PREVIOUS, valid.padEnd(256 * 1024 + 1)), /256 KiB/],
      ['only catalog', () => release.setListing([listing(PREVIOUS), listing(EARLIER, ['roles.json'])]), /only one catalog asset/],
      ['only signature', () => release.setListing([listing(PREVIOUS), listing(EARLIER, ['roles.json.sig'])]), /only one catalog asset/],
      ['duplicate id', () => release.signHistory(PREVIOUS, JSON.stringify({ ...base, roles: [entry, entry] })), /duplicate predecessor role/],
      ['role version exceeds catalog version', () => {
        release.setListing([listing(EARLIER)]);
        const source = entry.source.replace('/v' + PREVIOUS + '/', '/v' + EARLIER + '/');
        release.signHistory(EARLIER, JSON.stringify({ ...base, version: EARLIER, roles: [{ ...entry, source }] }));
      }, /predecessor role voice-mouth version 3\.160\.10 exceeds catalog version 3\.160\.9/],
      ...[
        ['bad version', { version: 'invalid' }], ['bad digest', { sha256: '123' }],
        ['bad id', { id: 'genie' }], ['not official', { official: false }], ['bad publisher', { publisher: 'community' }],
      ].map(([label, override]) => [
        label, () => release.signHistory(PREVIOUS, JSON.stringify({ ...base, roles: [{ ...entry, ...override }] })),
        /invalid predecessor role entry/,
      ] as const),
    ] as [string, () => void, RegExp, Record<string, string>?][]) {
      release.clearStage();
      release.setListing([listing(PREVIOUS)]);
      release.signHistory(PREVIOUS, valid);
      configure();
      const result = release.run(cut, overrides);
      expect(result.status, name).toBe(1);
      expect(result.stderr, name).toMatch(pattern);
      expect(result.stderr, name).toContain('restamp_roles=true on the next plugin cut');
      expect(existsSync(join(release.root, 'release/roles.json')), name).toBe(false);
      expect(release.calls().some(call => call.startsWith('release create')), name).toBe(false);
    }
  } finally { release.clean(); }
});

test('predecessor asset sizes must be present and within their limits before download', () => {
  const release = fixture();
  try {
    release.makeHistory(PREVIOUS);
    const limits = [262144, 1024];
    const assets = PAIR.map((name, i) => ({ name, size: limits[i] }));
    const cut = chain(PACK, WRITE);
    release.setListing([listing(PREVIOUS, PAIR, { assets })]);
    release.success(cut);
    expect(release.calls()[1]).toContain('release download v' + PREVIOUS);

    for (const [index, name] of PAIR.entries()) {
      for (const size of [limits[index] + 1, undefined, String(limits[index])]) {
        release.clearStage();
        release.setListing([listing(PREVIOUS, PAIR, { assets: assets.map(asset => asset.name === name ? { name, size } : asset) })]);
        const result = release.run(cut);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`has an invalid ${name} size`);
        expect(result.stderr).toContain('restamp_roles=true on the next plugin cut');
        expect(release.calls()).toEqual([`api --paginate --slurp repos/${REPO}/releases?per_page=100`]);
        expect(existsSync(join(release.root, 'release/roles.json'))).toBe(false);
      }
    }
  } finally { release.clean(); }
});

test('the real Check blocks tampering and Publish attaches both role files on stable and prerelease cuts', () => {
  const release = fixture();
  try {
    for (const prerelease of ['false', 'true']) {
      release.clearStage();
      release.success(chain(PACK, WRITE));
      release.success(SIGN.run, { PLUGIN_LANE_KEY: release.privateKey });
      const path = 'release/' + tarball(CUT);
      const original = readFileSync(join(release.root, path));
      const tampered = Buffer.from(original);
      tampered[9] = 3; // A valid gzip with a different digest.
      release.put(path, tampered);
      const checkAndPublish = chain(CHECK, PUBLISH);
      const failure = release.run(checkAndPublish, { PRERELEASE: prerelease });
      expect(failure.status).toBe(1);
      expect(failure.stderr).toContain('checksum does not match');
      expect(release.calls()).toHaveLength(1);
      expect(release.calls()[0]).toStartWith('api ');

      release.put(path, original);
      release.success(checkAndPublish, { PRERELEASE: prerelease });
      const publish = release.calls().at(-1)!;
      expect(publish).toStartWith('release create v' + CUT + ' ');
      expect(publish.split(' ')).toEqual(expect.arrayContaining([
        path, path + '.sha256', 'release/roles.json', 'release/roles.json.sig', '--latest=false',
      ]));
      expect(publish.includes(' --prerelease ')).toBe(prerelease === 'true');
    }
  } finally { release.clean(); }
});

test('the real desktop sweep keeps the role archives and checksums even with an empty plugin checksum list', () => {
  const release = fixture();
  try {
    const name = tarball(CUT);
    release.put('desktop-assets.txt', [name, name + '.sha256', ...PAIR, 'unknown.bin', 'automagik-role-x.tgz.sha256.old'].join('\n'));
    release.put('assets/fresh.bin', 'build');
    release.success(SWEEP.run);
    const deleted = release.calls().filter(call => call.startsWith('release delete-asset'));
    expect(deleted.map(call => call.split(' ')[3])).toEqual(['unknown.bin', 'automagik-role-x.tgz.sha256.old']);
    expect(release.calls().some(call => call.startsWith('release upload'))).toBe(true);
  } finally { release.clean(); }
});

test('documents stable role versions and the next-cut recovery option', () => {
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');
  const header = read('.github/workflows/release.yml').split('\n').slice(0, 120).join('\n');
  const rule = "A role's version is the release in which its package bytes last changed. Each later plugin cut attaches the same bytes under its own tag.";
  expect(header).toContain(rule);
  expect(header).toContain('restamp_roles=true] uses the cut version for every role on the next eligible plugin cut');
  const row = read('docs/rfcs/0011-monorepo-parts-and-releases.md').split('\n').find(line => line.startsWith('| Plugins |'));
  expect(row).toContain(rule);
  expect(row).toContain('automagik-role-<id>-<v>.tgz');
  const contract = read('docs/rfcs/0037-roles-not-types.md').replaceAll(/\s+/g, ' ');
  expect(contract).toContain("Its `<version>` is the release in which the package's bytes last changed; a later release attaches the same bytes under its own tag, so an unchanged role keeps its version and its sha256.");
  expect(contract).toContain("Alternative considered.** Stamping every release's version would show an update on every plugin release and block fresh attachments after a plugin upgrade and restart.");
  expect(read('plugin-lane/README.md')).toContain("It also attaches each official role's tarball and `.sha256`");
});

test('D2 the cut preserves the Solver mapping from its released predecessor', async () => {
  const { checkBundledSolver, stampBundledSolver } = await import('./role-pack');
  const { bundleDigest, expectedBundleDigest } = await import('../apps/bots-dsh/src/host/bundled-roles.js');
  const root = mkdtempSync(join(tmpdir(), 'solver-release-history-'));
  const role = PLUGIN + '/roles/solver';
  const history = PLUGIN + '/src/host/bundled-roles.json';
  const beforeSolver = '3.173.9';
  const first = '3.174.0';
  const next = '3.174.2';
  const commitFixture = (message: string) => {
    const file = join(root, '.git', 'test-message');
    writeFileSync(file, message + '\n');
    git(root, 'add', '--', PLUGIN);
    git(root, 'commit', '-q', '-F', file);
    return git(root, 'rev-parse', 'HEAD');
  };
  const digest = () => bundleDigest(new Map(['role.json', 'role.mjs', 'prompt.md']
    .map(name => [name, readFileSync(join(root, role, name))])));
  const mapping = (versions: Record<string, string>) =>
    writeFileSync(join(root, history), JSON.stringify({ candidate: digest(), solver: versions }));
  const inputs = (sha: string, version: string) => ({ root, sha, version, neverShipped: () => false });
  const historyOnDisk = () => JSON.parse(readFileSync(join(root, history), 'utf8'));
  try {
    git(root, 'init', '-q');
    mkdirSync(join(root, PLUGIN, 'src/host'), { recursive: true });
    mkdirSync(join(root, PLUGIN, 'roles'), { recursive: true });
    writeFileSync(join(root, PLUGIN, 'package.json'), JSON.stringify({ version: beforeSolver }));
    commitFixture('release without Solver');
    git(root, 'tag', 'v' + beforeSolver);
    cpSync(join(ROOT, role), join(root, role), { recursive: true });
    const old = digest();
    mapping({ [beforeSolver]: old, [first]: old });
    const retroactive = commitFixture('try to backdate the initial Solver history');
    expect(() => checkBundledSolver({ ...inputs(retroactive, first), release: true })).toThrow(/start new entries at the cut/);
    expect(() => stampBundledSolver(inputs(retroactive, first))).toThrow(/start new entries at the cut/);

    mapping({});
    const initial = commitFixture('initial Solver candidate');
    expect(() => checkBundledSolver(inputs(initial, beforeSolver))).not.toThrow();
    expect(expectedBundleDigest(historyOnDisk(), 'solver', beforeSolver)).toBeUndefined();
    stampBundledSolver(inputs(initial, first));
    writeFileSync(join(root, PLUGIN, 'package.json'), JSON.stringify({ version: first }));
    const firstCut = commitFixture('initial Solver release');
    expect(() => checkBundledSolver({ ...inputs(firstCut, first), release: true })).not.toThrow();
    expect(expectedBundleDigest(historyOnDisk(), 'solver', beforeSolver)).toBeUndefined();
    expect(expectedBundleDigest(historyOnDisk(), 'solver', first)).toBe(old);
    expect(expectedBundleDigest(historyOnDisk(), 'solver', '3.174.1')).toBeUndefined();
    git(root, 'tag', 'v' + first);
    writeFileSync(join(root, role, 'prompt.md'), 'Updated Solver method.\n');
    const current = digest();
    const check = (sha: string, predecessorVersion?: string) =>
      checkBundledSolver({ ...inputs(sha, next), predecessorVersion, release: true });
    mapping({ [first]: old });
    const candidate = commitFixture('update Solver sources before the version bump');
    expect(() => checkBundledSolver(inputs(candidate, first))).not.toThrow();
    stampBundledSolver(inputs(candidate, next));
    const valid = commitFixture('new Solver content range');
    expect(historyOnDisk().solver).toEqual({ [first]: old, [next]: current });
    expect(() => check(valid, first)).not.toThrow();
    expect(() => check(valid)).not.toThrow();
    mapping({ [next]: current });
    const removed = commitFixture('omit the earlier content range');
    expect(() => check(removed, first)).toThrow(/preserve the released predecessor/);
    expect(() => check(removed)).toThrow(/preserve the released predecessor/);
    mapping({ [first]: old });
    const unstamped = commitFixture('omit the current content range');
    expect(() => check(unstamped, first)).toThrow(/bundled digest differs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
