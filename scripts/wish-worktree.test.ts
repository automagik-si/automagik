import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'wish-worktree.sh');
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  WISH_SHARED_ROOT: '/nonexistent/wish-worktree-test',
};
const owned: string[] = [];

afterEach(() => {
  for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: 'pipe' }).trim();
}

function run(args: string[]) {
  const child = spawnSync('sh', [SCRIPT, ...args], { encoding: 'utf8', env: ENV });
  return { code: child.status ?? -1, stdout: child.stdout, stderr: child.stderr };
}

function remoteFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wish-worktree-'));
  owned.push(dir);
  const remote = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'dev', remote);
  const seed = join(dir, 'seed');
  git(dir, 'clone', '-q', remote, seed);
  writeFileSync(join(seed, 'product.txt'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'base');
  git(seed, 'push', '-q', 'origin', 'dev');
  return { dir, remote };
}

test('create shares one clone, and remove refuses dirty but removes and prunes clean', () => {
  const { dir, remote } = remoteFixture();
  const shared = join(dir, 'shared');
  const copies = join(dir, 'copies');
  mkdirSync(copies);
  const one = join(copies, 'one');
  const two = join(copies, 'two');
  const made = run(['--shared', shared, 'create', remote, one, 'wish/one', 'origin/dev']);
  expect(made.code).toBe(0);
  expect(lstatSync(join(one, '.git')).isFile()).toBe(true);
  expect(git(shared, 'worktree', 'list', '--porcelain')).toContain(one);
  expect(git(one, 'branch', '--show-current')).toBe('wish/one');
  expect(git(one, 'rev-parse', 'HEAD')).toBe(git(shared, 'rev-parse', 'origin/dev'));
  const second = run(['--shared', shared, 'create', remote, two, 'wish/two', 'origin/dev']);
  expect(second.code).toBe(0);
  expect(git(two, 'branch', '--show-current')).toBe('wish/two');
  expect(git(one, 'branch', '--show-current')).not.toBe(git(two, 'branch', '--show-current'));

  const main = run(['--shared', shared, 'remove', shared]);
  expect(main.code).toBe(1);
  expect(main.stderr).toContain('not a linked worktree');

  writeFileSync(join(one, 'product.txt'), 'dirty\n');
  const dirty = run(['--shared', shared, 'remove', one]);
  expect(dirty.code).toBe(1);
  expect(dirty.stderr).toContain('dirty');
  expect(git(shared, 'worktree', 'list', '--porcelain')).toContain(one);

  git(one, 'checkout', '--', 'product.txt');
  const clean = run(['--shared', shared, 'remove', one]);
  expect(clean.code).toBe(0);
  expect(existsSync(one)).toBe(false);
  expect(git(shared, 'worktree', 'list', '--porcelain')).not.toContain(one);
  expect(git(two, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('wish/two');
  expect(existsSync(join(two, 'product.txt'))).toBe(true);
  const admin = join(shared, '.git', 'worktrees');
  expect(existsSync(admin) ? readdirSync(admin).length : 0).toBe(1);
});

test('create refuses an existing copy, a duplicate branch, and a missing base', () => {
  const { dir, remote } = remoteFixture();
  const shared = join(dir, 'shared');
  const copy = join(dir, 'copies', 'one');
  expect(run(['--shared', shared, 'create', remote, copy, 'wish/one', 'origin/dev']).code).toBe(0);
  expect(run(['--shared', shared, 'create', remote, copy, 'wish/one', 'origin/dev']).code).toBe(1);
  const duplicate = run(['--shared', shared, 'create', remote, join(dir, 'copies', 'two'),
    'wish/one', 'origin/dev']);
  expect(duplicate.code).toBe(1);
  expect(duplicate.stderr).toContain('branch already exists');
  const missing = run(['--shared', shared, 'create', remote, join(dir, 'copies', 'three'),
    'wish/three', 'origin/nope']);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain('base not found');
  expect(existsSync(join(dir, 'copies', 'two'))).toBe(false);
});
