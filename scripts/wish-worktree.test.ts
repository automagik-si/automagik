import { afterEach, expect, test } from 'bun:test';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync,
  writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgs, reap } from './wish-reap.mjs';

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
  return { dir, remote, seed };
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

test('remove refuses every *.lock under the shared git dir', () => {
  const { dir, remote } = remoteFixture();
  const shared = join(dir, 'shared');
  const copies = join(dir, 'copies');
  mkdirSync(copies);
  const copy = join(copies, 'one');
  expect(run(['--shared', shared, 'create', remote, copy, 'wish/one', 'origin/dev']).code).toBe(0);
  const stale = join(copies, 'stale');
  expect(run(['--shared', shared, 'create', remote, stale, 'wish/stale', 'origin/dev']).code)
    .toBe(0);
  rmSync(stale, { recursive: true, force: true });
  const locks = ['.git/packed-refs.lock', '.git/refs/heads/wish.lock', '.git/shallow.lock'];
  for (const lock of locks) {
    const path = join(shared, lock);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    const refused = run(['--shared', shared, 'remove', copy]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('locked');
    expect(existsSync(copy)).toBe(true);
    expect(git(shared, 'worktree', 'list', '--porcelain')).toContain(copy);
    rmSync(path);
  }
  const removed = run(['--shared', shared, 'remove', copy]);
  expect(removed.code).toBe(0);
  expect(existsSync(copy)).toBe(false);
  const admin = join(shared, '.git', 'worktrees');
  expect(existsSync(admin) ? readdirSync(admin).length : 0).toBe(0);
});

test('concurrent worktrees and borrowing clones initialise a single shared store', async () => {
  const { dir, remote } = remoteFixture();
  const sharedRoot = join(dir, 'wishes', '.shared');
  const root = join(dir, 'wishes', 'remote');
  const copies = ['one', 'two', 'three', 'four'].map((name) => join(root, name));
  const runAsync = promisify(execFile);
  const results = await Promise.allSettled(copies.map((copy, index) => {
    const mode = index < 2 ? [] : ['--shared-clone'];
    return runAsync('sh', [SCRIPT, '--shared-root', sharedRoot, ...mode, 'create', remote,
      copy, 'wish/concurrent-' + index], { env: ENV });
  }));
  expect(results.map((result) => result.status === 'fulfilled' ? 'created' : result.reason.stderr))
    .toEqual(['created', 'created', 'created', 'created']);

  const shared = join(sharedRoot, 'remote');
  const common = join(shared, '.git');
  expect(readdirSync(sharedRoot)).toEqual(['remote']);
  expect(existsSync(join(shared, 'product.txt'))).toBe(false);
  for (const [index, copy] of copies.entries()) {
    expect(git(copy, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
      .toBe(index < 2 ? common : join(copy, '.git'));
    expect(git(copy, 'branch', '--show-current')).toBe(`wish/concurrent-${index}`);
  }
  git(copies[0], 'commit', '--allow-empty', '-qm', 'only in the first wish');
  expect(git(copies[0], 'rev-parse', 'HEAD')).not.toBe(git(copies[1], 'rev-parse', 'HEAD'));

  const other = join(dir, 'other', 'remote.git');
  mkdirSync(dirname(other));
  git(dir, 'clone', '-q', '--bare', remote, other);
  const mismatched = run(['--shared-root', sharedRoot, 'create', other, join(root, 'wrong'),
    'wish/wrong']);
  expect(mismatched.stderr).toContain('different origin');
  expect(existsSync(join(root, 'wrong'))).toBe(false);
}, 15_000);

test('shared clones borrow objects and keep git writes and publish setup inside each copy', () => {
  const { dir, remote } = remoteFixture();
  const project = join(dir, 'project');
  git(dir, 'clone', '-q', remote, project);
  git(project, 'branch', 'wish/granted');
  const shared = join(dir, 'wishes', '.shared', 'project');
  const root = join(dir, 'wishes', 'project');
  const published = join(root, 'published');
  const retained = join(root, 'retained');

  function create(copy: string, branch: string, base: string) {
    const result = run(['--shared', shared, '--shared-clone', 'create', project, copy, branch, base]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  }

  create(published, 'wish/published', 'origin/dev');
  const publishedBase = git(published, 'rev-parse', 'HEAD');
  const objects = git(shared, 'count-objects', '-v');
  create(retained, 'wish/retained', 'origin/dev');
  expect(git(shared, 'count-objects', '-v')).toBe(objects);

  for (const copy of [published, retained]) {
    expect(lstatSync(join(copy, '.git')).isDirectory()).toBe(true);
    expect(git(copy, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
      .toBe(join(copy, '.git'));
    expect(git(copy, 'count-objects', '-v')).toContain('count: 0\n');
    expect(git(copy, 'count-objects', '-v')).toContain('in-pack: 0\n');
    expect(git(copy, 'count-objects', '-v')).toContain(`alternate: ${shared}/.git/objects`);
    expect(git(copy, 'remote', 'get-url', 'origin')).toBe(project);
    expect(git(copy, 'remote', 'get-url', '--push', 'origin'))
      .toBe('/dev/null/genie-wish-copies-push-nowhere');
    expect(git(copy, 'config', '--local', '--get', 'credential.helper')).toBe('');
    expect(git(copy, 'rev-parse', 'origin/wish/granted')).toBe(publishedBase);
  }

  expect(git(published, 'branch', '--show-current')).toBe('wish/published');
  expect(git(retained, 'branch', '--show-current')).toBe('wish/retained');
  git(published, 'commit', '--allow-empty', '-qm', 'publish only this wish');
  const lockedOut = spawnSync('git', ['push', 'origin', 'HEAD:refs/heads/wish/published'],
    { cwd: published, env: ENV });
  expect(lockedOut.status).not.toBe(0);
  git(published, 'config', '--local', '--unset-all', 'credential.helper');
  git(published, 'remote', 'add', 'publish', remote);
  git(published, 'push', '-q', 'publish', 'HEAD:refs/pull/271/head');
  expect(git(retained, 'remote')).toBe('origin');
  expect(git(retained, 'config', '--local', '--get', 'credential.helper')).toBe('');
  expect(git(retained, 'rev-parse', 'HEAD')).toBe(publishedBase);
  expect(git(shared, 'count-objects', '-v')).toBe(objects);

  writeFileSync(join(retained, 'product.txt'), 'dirty work stays here\n');
  const options = parseArgs(['--root', root, '--shared', shared, '--remote', 'publish',
    '--idle-minutes', '0', '--apply']);
  const result = reap(options);
  expect(result.copies).toEqual([
    expect.objectContaining({ name: 'published', decision: 'remove', reason: 'head-on-remote' }),
    expect.objectContaining({ name: 'retained', decision: 'keep', reason: 'dirty' }),
  ]);
  expect(result.summary.removed).toBe(1);
  expect(existsSync(published)).toBe(false);

  git(retained, 'add', 'product.txt');
  git(retained, 'commit', '-qm', 'unpushed change');
  git(retained, 'remote', 'add', 'publish', remote);
  const head = git(retained, 'rev-parse', 'HEAD');
  git(project, 'fetch', '-q', retained, 'HEAD:refs/heads/wish/retained');
  const afterFetchBack = reap(options);
  expect(afterFetchBack.copies[0]).toMatchObject({ sha: head, decision: 'keep', reason: 'unpublished' });
  expect(git(retained, 'rev-parse', 'HEAD')).toBe(head);
});

test('shared clones can start from an exact source commit available only in FETCH_HEAD', () => {
  const { dir, remote, seed } = remoteFixture();
  const project = join(dir, 'project');
  git(dir, 'clone', '-q', remote, project);
  const shared = join(dir, 'shared');
  const create = (...args: string[]) => run(['--shared', shared, '--shared-clone', 'create',
    project, ...args]);
  expect(create(join(dir, 'one'), 'wish/one').code).toBe(0);
  git(seed, 'commit', '--allow-empty', '-qm', 'upstream tip fetched without a destination');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/pull/94/head');
  git(project, 'fetch', '-q', '--no-tags', remote, 'refs/pull/94/head');
  const tip = git(project, 'rev-parse', 'FETCH_HEAD');
  expect(git(project, 'for-each-ref', '--points-at', tip)).toBe('');

  const copy = join(dir, 'two');
  expect(create(copy, 'wish/two', tip).code).toBe(0);
  expect(git(copy, 'rev-parse', 'HEAD')).toBe(tip);
  expect(git(copy, 'count-objects', '-v')).toContain('count: 0\n');
  expect(git(copy, 'count-objects', '-v')).toContain('in-pack: 0\n');
});

test('refresh and normal Git GC preserve objects borrowed from a deleted source branch', () => {
  const { dir, remote } = remoteFixture();
  const project = join(dir, 'project');
  git(dir, 'clone', '-q', remote, project);
  git(project, 'checkout', '-qb', 'temporary');
  git(project, 'commit', '--allow-empty', '-qm', 'only borrowed by the first wish');
  const tip = git(project, 'rev-parse', 'HEAD');
  git(project, 'checkout', '-q', 'dev');
  const shared = join(dir, 'shared');
  const create = (...args: string[]) => run(['--shared', shared, '--shared-clone', 'create',
    project, ...args]);
  const first = join(dir, 'one');
  expect(create(first, 'wish/one', tip).code).toBe(0);
  git(project, 'branch', '-D', 'temporary');
  expect(create(join(dir, 'two'), 'wish/two').code).toBe(0);
  expect(git(shared, 'for-each-ref', '--points-at', tip)).toBe('');
  git(shared, 'gc', '--quiet');
  expect(git(first, 'show', '-s', '--format=%s', tip)).toBe('only borrowed by the first wish');
});
