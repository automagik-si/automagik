import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packCheckout } from './server-checkout';
import { CHECKOUT_PACKAGES, CHECKOUT_REPOSITORY, CHILD, sha256, verifyCheckoutDirectory } from '../server/checkout-input.mjs';

const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'server-pack-test-')); owned.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'automagik', version: '1.2.3' }));
  for (const [name, folder] of Object.entries(CHECKOUT_PACKAGES)) {
    mkdirSync(join(root, folder, 'src/host/browser'), { recursive: true });
    writeFileSync(join(root, folder, 'package.json'), JSON.stringify({ name, version: '1.2.3', files: ['src/', 'index.js'], scripts: {
      prepack: 'touch hook-ran', prepare: 'touch hook-ran', postpack: 'touch hook-ran',
    } }, null, 2) + '\n');
    writeFileSync(join(root, folder, 'index.js'), 'export const plugin = true;\n');
    writeFileSync(join(root, folder, 'src/host/browser/script-child.js'), 'committed child\n');
    writeFileSync(join(root, folder, '.gitignore'), 'src/ignored.js\n');
    writeFileSync(join(root, folder, 'excluded.txt'), 'not selected by normal package files\n');
  }
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const revision = git('rev-parse', 'HEAD');
  return { root, revision, git, event: 'pull_request' };
}
function pack(input: ReturnType<typeof fixture>) {
  const result = packCheckout(input); owned.push(result.staging); return result;
}

test('real normal Bun pack needs no plugin dependencies, skips hooks, binds child and normal manifest/SRI/SHA', () => {
  const f = fixture(); const p = pack(f);
  const result = verifyCheckoutDirectory(p.dir, { kind: 'checkout', event: f.event, revision: p.revision,
    version: p.version, manifest: p.manifest, repository: CHECKOUT_REPOSITORY });
  expect(Object.keys(result.plugins).sort()).toEqual(['@automagik/acp-dsh', '@automagik/bots-dsh', '@automagik/welcome-dsh']);
  const manifest = JSON.parse(readFileSync(join(p.dir, 'plugins.json'), 'utf8'));
  expect(Object.keys(manifest.packages)).toEqual(Object.keys(CHECKOUT_PACKAGES));
  expect(manifest.commit).toBe(f.revision);
  expect(p.child).toBe(sha256(readFileSync(join(f.root, CHILD))));
  for (const folder of Object.values(CHECKOUT_PACKAGES)) {
    expect(existsSync(join(f.root, folder, 'hook-ran'))).toBe(false);
    expect(existsSync(join(f.root, folder, 'node_modules'))).toBe(false);
  }
  const archive = join(p.dir, manifest.packages['@automagik/bots-dsh'].file);
  const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  expect(members).not.toContain('excluded.txt');
  expect(execFileSync('tar', ['-xOzf', archive, 'package/src/host/browser/script-child.js']).equals(readFileSync(join(f.root, CHILD)))).toBe(true);
  expect(f.git('status', '--porcelain')).toBe('');
});

test('wrong events/revisions fail before packing', () => {
  const f = fixture();
  for (const event of ['push', 'release', 'workflow_dispatch', '', 'unknown']) expect(() => pack({ ...f, event })).toThrow(/pull_request/);
  for (const revision of ['main', 'a'.repeat(40)]) expect(() => pack({ ...f, revision })).toThrow(/revision|HEAD/);
});

for (const change of ['unstaged', 'staged', 'untracked', 'ignored', 'symlink', 'wrong-name', 'wrong-version', 'extra-package']) {
  test(`refuses ${change} source without changing HEAD or the source`, () => {
    const f = fixture();
    if (change === 'unstaged' || change === 'staged') {
      writeFileSync(join(f.root, CHILD), 'changed\n');
      if (change === 'staged') f.git('add', CHILD);
    } else if (change === 'untracked' || change === 'ignored') {
      writeFileSync(join(f.root, 'apps/bots-dsh/src', change === 'ignored' ? 'ignored.js' : 'untracked.js'), 'not committed');
    } else if (change === 'symlink') {
      rmSync(join(f.root, CHILD)); symlinkSync(join(f.root, 'package.json'), join(f.root, CHILD));
    } else if (change === 'extra-package') {
      mkdirSync(join(f.root, 'apps/extra-dsh')); writeFileSync(join(f.root, 'apps/extra-dsh/package.json'), '{"name":"@automagik/extra-dsh"}');
    } else {
      const file = join(f.root, 'apps/bots-dsh/package.json'); const pkg = JSON.parse(readFileSync(file, 'utf8'));
      pkg[change === 'wrong-name' ? 'name' : 'version'] = change === 'wrong-name' ? '@automagik/imposter' : '2.0.0';
      writeFileSync(file, JSON.stringify(pkg));
      f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'mismatch');
      f.revision = f.git('rev-parse', 'HEAD');
    }
    const before = f.git('status', '--porcelain');
    const error = ['unstaged', 'staged', 'symlink'].includes(change) ? /dirty checkout source/
      : ['untracked', 'ignored'].includes(change) ? /packed bytes are not HEAD/
      : change === 'wrong-version' ? /name\/folder\/version mismatch/ : /unexpected plugin identities/;
    expect(() => pack(f)).toThrow(error);
    expect(f.git('status', '--porcelain')).toBe(before);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.revision);
  });
}
