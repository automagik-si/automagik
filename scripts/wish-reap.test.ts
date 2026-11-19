import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, reap } from './wish-reap.mjs';

const SCRIPT = join(import.meta.dir, 'wish-reap.mjs');
const NAMES = ['a-clean', 'b-dirty', 'c-local-product', 'd-local-handoffs', 'e-locked', 'f-recent'];
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const owned: string[] = [];

afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: 'pipe' }).trim();
}

function run(args: string[]) {
  const child = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: ENV });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

/** Age every path in `target`, deepest first, so the idle gate sees a quiet copy. */
function backdate(target: string, minutes = 120) {
  const when = new Date(Date.now() - minutes * 60_000);
  const walk = (path: string) => {
    const info = lstatSync(path);
    if (info.isDirectory()) for (const child of readdirSync(path)) walk(join(path, child));
    utimesSync(path, when, when);
  };
  walk(target);
}

/** A bare repository plus a seed commit, the fake remote every fixture clone points at. */
function remoteFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wish-reap-'));
  owned.push(dir);
  const remote = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'dev', remote);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '-q', remote, seed);
  mkdirSync(join(seed, 'handoffs'));
  mkdirSync(join(seed, 'docs'));
  writeFileSync(join(seed, 'product.txt'), 'one\n');
  writeFileSync(join(seed, 'handoffs', 'report.md'), 'report\n');
  writeFileSync(join(seed, 'docs', 'note.md'), 'note\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', 'origin', 'dev');
  return { dir, remote };
}

/** The six cases: clean, dirty, local product, local handoffs, locked, recently touched. */
function fixture() {
  const { dir, remote } = remoteFixture();
  const root = join(dir, 'copies');
  mkdirSync(root);
  for (const name of NAMES) git(dir, 'clone', '-q', remote, join(root, name));
  writeFileSync(join(root, 'b-dirty', 'product.txt'), 'dirty\n');
  const product = join(root, 'c-local-product');
  writeFileSync(join(product, 'product.txt'), 'local\n');
  git(product, 'commit', '-qam', 'local product change');
  const handoffs = join(root, 'd-local-handoffs');
  writeFileSync(join(handoffs, 'handoffs', 'new-report.md'), 'local report\n');
  git(handoffs, 'add', '-A');
  git(handoffs, 'commit', '-qm', 'local report');
  writeFileSync(join(root, 'e-locked', '.git', 'index.lock'), '');
  for (const name of NAMES) backdate(join(root, name));
  const when = new Date();
  utimesSync(join(root, 'f-recent', 'product.txt'), when, when);
  return { dir, remote, root, preserve: join(dir, 'preserved') };
}

describe('wish-reap', () => {
  test('dry run classifies the six cases and touches nothing', () => {
    const f = fixture();
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve]));
    const byName = new Map(result.copies.map((entry: { name: string }) => [entry.name, entry]));
    expect([...byName.keys()].sort()).toEqual([...NAMES].sort());
    expect(byName.get('a-clean')?.decision).toBe('remove');
    expect(byName.get('a-clean')?.reason).toBe('head-on-remote');
    expect(byName.get('d-local-handoffs')?.decision).toBe('remove');
    expect(byName.get('d-local-handoffs')?.reason).toBe('local-only-handoffs');
    expect(byName.get('b-dirty')?.decision).toBe('keep');
    expect(byName.get('b-dirty')?.reason).toBe('dirty');
    expect(byName.get('c-local-product')?.decision).toBe('keep');
    expect(byName.get('c-local-product')?.reason).toBe('unpublished');
    expect(byName.get('e-locked')?.decision).toBe('keep');
    expect(byName.get('e-locked')?.reason).toBe('locked');
    expect(byName.get('f-recent')?.decision).toBe('keep');
    expect(byName.get('f-recent')?.reason).toBe('recent');
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.preserve)).toBe(false);
    for (const name of NAMES) expect(existsSync(join(f.root, name))).toBe(true);
  });

  test('apply removes a and d, preserves the local report, and keeps the rest', () => {
    const f = fixture();
    const reportSha = git(join(f.root, 'd-local-handoffs'), 'rev-parse', 'HEAD');
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(result.summary.total).toBe(6);
    expect(result.summary.remove).toBe(2);
    expect(result.summary.keep).toBe(4);
    expect(result.summary.removed).toBe(2);
    expect(result.summary.keptForLostWork.sort()).toEqual(['b-dirty', 'c-local-product']);
    expect(existsSync(join(f.root, 'a-clean'))).toBe(false);
    expect(existsSync(join(f.root, 'd-local-handoffs'))).toBe(false);
    for (const name of ['b-dirty', 'c-local-product', 'e-locked', 'f-recent']) {
      expect(existsSync(join(f.root, name))).toBe(true);
    }
    expect(readFileSync(join(f.preserve, 'd-local-handoffs', 'handoffs', 'new-report.md'), 'utf8'))
      .toBe('local report\n');
    expect(readFileSync(join(f.preserve, 'd-local-handoffs', '.wish-reap-commits.txt'), 'utf8'))
      .toContain(reportSha);
    const clean = result.copies.find((entry: { name: string }) => entry.name === 'a-clean');
    expect(clean?.sizeBytes).toBeGreaterThan(0);
    expect(clean?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  test('the CLI prints one line per copy, honours --json, and exits 1 for lost work', () => {
    const f = fixture();
    const human = run(['--root', f.root, '--preserve', f.preserve]);
    expect(human.code).toBe(1);
    expect(human.stdout).toContain('would-remove\ta-clean\thead-on-remote');
    expect(human.stdout).toContain('keep\tb-dirty\tdirty');
    const dry = run(['--root', f.root, '--preserve', f.preserve, '--json']);
    expect(dry.code).toBe(1);
    const parsed = JSON.parse(dry.stdout);
    expect(parsed.apply).toBe(false);
    expect(parsed.summary.total).toBe(6);
    expect(parsed.summary.keptForLostWork).toEqual(['b-dirty', 'c-local-product']);
    expect(parsed.copies.filter((entry: { decision: string }) => entry.decision === 'remove')
      .map((entry: { name: string }) => entry.name)).toEqual(['a-clean', 'd-local-handoffs']);
    expect(existsSync(join(f.root, 'a-clean'))).toBe(true);
    const applied = run(['--root', f.root, '--preserve', f.preserve, '--apply', '--json']);
    expect(applied.code).toBe(1);
    expect(JSON.parse(applied.stdout).summary.removed).toBe(2);
    expect(existsSync(join(f.root, 'a-clean'))).toBe(false);
  });

  test('a registered worktree of the shared clone is removed and the shared clone pruned', () => {
    const { dir, remote } = remoteFixture();
    const shared = join(dir, 'shared');
    git(dir, 'clone', '-q', remote, shared);
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', remote, other);
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'w-worktree');
    git(shared, 'worktree', 'add', '-q', copy, '-b', 'wish/worktree', 'origin/dev');
    const preserve = join(dir, 'preserved');
    const wrong = reap(parseArgs(['--root', root, '--preserve', preserve, '--shared', other,
      '--idle-minutes', '0']));
    expect(wrong.copies[0].decision).toBe('keep');
    expect(wrong.copies[0].reason).toBe('worktree-not-of-shared');
    expect(wrong.exitCode).toBe(0);
    const result = reap(parseArgs(['--root', root, '--preserve', preserve, '--shared', shared,
      '--idle-minutes', '0', '--apply']));
    expect(result.copies[0].decision).toBe('remove');
    expect(result.copies[0].method).toBe('worktree-remove');
    expect(result.copies[0].removed).toBe(true);
    expect(result.summary.pruned).toEqual([shared]);
    expect(existsSync(copy)).toBe(false);
    expect(git(shared, 'worktree', 'list', '--porcelain')).not.toContain(copy);
  });
});
