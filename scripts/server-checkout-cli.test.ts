import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CHECKOUT_PACKAGES, CHECKOUT_REPOSITORY, CHILD, sha256, verifyCheckoutDirectory } from '../server/checkout-input.mjs';

const source = resolve(import.meta.dir, '..');
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'server-pack-cli-test-')); owned.push(root);
  // Copy the real CLI and its local import chain: ROOT still derives from import.meta.dir.
  for (const file of ['scripts/server-checkout.ts', 'scripts/release-plugins.ts', 'scripts/marketplace.ts',
    'scripts/version.ts', 'server/checkout-input.mjs', 'server/fetch-plugins.mjs']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(source, file), join(root, file));
  }
  symlinkSync(join(source, 'node_modules'), join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'automagik', version: '1.2.3' }));
  for (const [name, folder] of Object.entries(CHECKOUT_PACKAGES)) {
    mkdirSync(join(root, folder, 'src/host/browser'), { recursive: true });
    writeFileSync(join(root, folder, 'package.json'), JSON.stringify({ name, version: '1.2.3', files: ['src/'] }, null, 2) + '\n');
    writeFileSync(join(root, folder, 'src/host/browser/script-child.js'), 'committed CLI fixture child\n');
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  const temporary = join(root, 'temporary'); mkdirSync(temporary);
  const output = join(root, 'github-output');
  return { root, revision, git, temporary, output, target: join(root, 'server/checkout-input'),
    env: { ...env, TMPDIR: temporary, GITHUB_OUTPUT: output } };
}

function cli(f: ReturnType<typeof fixture>, preload?: string) {
  return spawnSync(process.execPath, [...(preload ? ['--preload', preload] : []),
    join(f.root, 'scripts/server-checkout.ts'), 'pull_request', f.revision], {
    cwd: f.root, env: f.env, encoding: 'utf8',
  });
}

function verify(f: ReturnType<typeof fixture>) {
  const output = readFileSync(f.output, 'utf8');
  const manifest = sha256(readFileSync(join(f.target, 'plugins.json')));
  const child = sha256(readFileSync(join(f.root, CHILD)));
  expect(output).toBe(`manifest=${manifest}\nchild=${child}\nrevision=${f.revision}\n`);
  const result = verifyCheckoutDirectory(f.target, { kind: 'checkout', event: 'pull_request', revision: f.revision,
    version: '1.2.3', manifest, repository: CHECKOUT_REPOSITORY });
  expect(result.assets.size).toBe(6);
  const archive = join(f.target, 'automagik-bots-dsh-1.2.3.tgz');
  expect(execFileSync('tar', ['-xOzf', archive, 'package/src/host/browser/script-child.js'])
    .equals(readFileSync(join(f.root, CHILD)))).toBe(true);
  expect(readdirSync(f.temporary)).toEqual([]);
  expect(f.git('diff', 'HEAD', '--')).toBe('');
  expect(f.git('rev-parse', 'HEAD')).toBe(f.revision);
}

test('actual CLI stages a fresh fixed destination and emits verified workflow bindings', () => {
  const f = fixture(); const result = cli(f);
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain(`checkout inputs: ${f.revision}`);
  verify(f);
  const before = readdirSync(f.target).map((file) => [file, sha256(readFileSync(join(f.target, file)))]);
  const again = cli(f);
  expect(again.status).not.toBe(0); expect(again.stderr).toContain('EEXIST');
  expect(readdirSync(f.target).map((file) => [file, sha256(readFileSync(join(f.target, file)))])).toEqual(before);
  verify(f); // A losing invocation neither removes the winner's files nor appends outputs.
});

for (const kind of ['empty-directory', 'stale-directory', 'file', 'symlink', 'dangling-symlink']) {
  test(`actual CLI refuses an existing ${kind} without overwriting or cleaning it`, () => {
    const f = fixture();
    const referent = join(f.root, 'referent');
    if (kind.endsWith('directory')) {
      mkdirSync(f.target);
      if (kind === 'stale-directory') writeFileSync(join(f.target, 'sentinel'), 'keep stale bytes');
    } else if (kind === 'file') writeFileSync(f.target, 'keep file bytes');
    else {
      if (kind === 'symlink') { mkdirSync(referent); writeFileSync(join(referent, 'sentinel'), 'keep referent bytes'); }
      symlinkSync(referent, f.target, 'dir');
    }
    const result = cli(f);
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('EEXIST');
    expect(result.stdout).toBe(''); expect(existsSync(f.output)).toBe(false);
    expect(readdirSync(f.temporary)).toEqual([]);
    if (kind.endsWith('directory')) {
      expect(lstatSync(f.target).isDirectory()).toBe(true);
      expect(readdirSync(f.target)).toEqual(kind === 'stale-directory' ? ['sentinel'] : []);
      if (kind === 'stale-directory') expect(readFileSync(join(f.target, 'sentinel'), 'utf8')).toBe('keep stale bytes');
    } else if (kind === 'file') expect(readFileSync(f.target, 'utf8')).toBe('keep file bytes');
    else {
      expect(lstatSync(f.target).isSymbolicLink()).toBe(true); expect(readlinkSync(f.target)).toBe(referent);
      if (kind === 'symlink') {
        expect(readdirSync(referent)).toEqual(['sentinel']);
        expect(readFileSync(join(referent, 'sentinel'), 'utf8')).toBe('keep referent bytes');
      } else expect(existsSync(referent)).toBe(false);
    }
  });
}

for (const failure of ['copy-error', 'asset-collision']) test(`actual CLI cleans partial staging after ${failure}`, () => {
  const f = fixture();
  const preload = join(f.root, 'copy-failure.mjs');
  // Fault injection only in this subprocess: first copy is real, second fails.
  writeFileSync(preload, `import fs from 'node:fs';
import { mock } from 'bun:test';
const copy = fs.cpSync;
let copies = 0;
mock.module('node:fs', () => ({ ...fs, cpSync: (...args) => {
  if (++copies === 2) {
    if (${JSON.stringify(failure)} === 'copy-error') throw new Error('injected second asset copy failure');
    fs.writeFileSync(args[1], 'keep colliding bytes');
    try { return copy(...args); }
    finally { fs.writeFileSync(${JSON.stringify(join(f.root, 'collision'))}, fs.readFileSync(args[1])); }
  }
  const result = copy(...args);
  fs.writeFileSync(${JSON.stringify(join(f.root, 'copied'))}, fs.readFileSync(args[1]));
  return result;
} }));
`);
  const result = cli(f, preload);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(failure === 'copy-error' ? 'injected second asset copy failure' : 'EEXIST');
  if (failure === 'asset-collision') expect(readFileSync(join(f.root, 'collision'), 'utf8')).toBe('keep colliding bytes');
  expect(readFileSync(join(f.root, 'copied')).length).toBeGreaterThan(0);
  expect(existsSync(f.target)).toBe(false); expect(readdirSync(f.temporary)).toEqual([]);
  expect(existsSync(f.output)).toBe(false); expect(result.stdout).toBe('');
});

test('actual CLI removes its owned destination if workflow output reporting fails', () => {
  const f = fixture(); mkdirSync(f.output);
  const result = cli(f);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('EISDIR');
  expect(existsSync(f.target)).toBe(false); expect(readdirSync(f.temporary)).toEqual([]);
  expect(lstatSync(f.output).isDirectory()).toBe(true); expect(result.stdout).toBe('');
});

test('concurrent actual CLI invocations have exactly one destination owner', async () => {
  const f = fixture();
  const run = async () => {
    const child = Bun.spawn([process.execPath, join(f.root, 'scripts/server-checkout.ts'), 'pull_request', f.revision], {
      cwd: f.root, env: f.env, stdout: 'pipe', stderr: 'pipe',
    });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { status, stderr };
  };
  const results = await Promise.all([run(), run()]);
  expect(results.filter((r) => r.status === 0)).toHaveLength(1);
  const loser = results.find((r) => r.status !== 0)!;
  expect(loser.stderr).toContain('EEXIST');
  verify(f);
});
