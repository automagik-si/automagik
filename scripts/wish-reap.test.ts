import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    lutimesSync(path, when, when);
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

describe('wish-reap: no ref may hide unpublished work', () => {
  /** A clean copy under its own root (the fixture's `seed` is not inside it). */
  function copyOf(name = 'copy') {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, name);
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  test('a stale local origin/* ref cannot hide an unpublished product commit', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(f.copy, 'product.txt'), 'stale product\n');
    git(f.copy, 'commit', '-qam', 'product change');
    const product = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'push', '-q', 'origin', 'feature');
    git(f.remote, 'branch', '-D', 'feature');
    writeFileSync(join(f.copy, 'handoffs', 'follow.md'), 'follow up\n');
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', 'docs on top');
    const tip = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'update-ref', 'refs/remotes/origin/feature', product);
    expect(git(f.copy, 'rev-parse', 'origin/feature')).toBe(product);
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'))
      .toBe('refs/heads/dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(result.copies).toHaveLength(1);
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpublished');
    expect(entry.detail).toContain('refs/heads/feature');
    expect(entry.detail).toContain('product.txt');
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(f.copy, 'product.txt'))).toBe(true);
    expect(git(f.copy, 'rev-parse', 'feature')).toBe(tip);
  });

  test('a published HEAD cannot authorize removing an unpublished local branch', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'wip');
    writeFileSync(join(f.copy, 'product.txt'), 'wip product\n');
    git(f.copy, 'commit', '-qam', 'wip product');
    const wip = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'checkout', '-q', 'dev');
    expect(git(f.copy, 'rev-parse', 'HEAD')).toBe(git(f.remote, 'rev-parse', 'dev'));
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(result.copies).toHaveLength(1);
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpublished');
    expect(entry.detail).toContain('refs/heads/wip');
    expect(result.exitCode).toBe(1);
    expect(git(f.copy, 'rev-parse', 'wip')).toBe(wip);
  });

  test('a local tag to an unpublished commit keeps the copy', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'tagged');
    writeFileSync(join(f.copy, 'product.txt'), 'tagged product\n');
    git(f.copy, 'commit', '-qam', 'tagged product');
    git(f.copy, 'tag', 'v-local');
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'branch', '-D', 'tagged');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpublished');
    expect(entry.detail).toContain('refs/tags/v-local');
    expect(result.exitCode).toBe(1);
  });

  test('a commit advertised only by a pull-request ref is published', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'pr');
    writeFileSync(join(f.copy, 'product.txt'), 'pull product\n');
    git(f.copy, 'commit', '-qam', 'pull product');
    const pull = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'push', '-q', 'origin', `HEAD:refs/pull/77/head`);
    git(f.copy, 'checkout', '-q', 'dev');
    expect(git(f.remote, 'rev-parse', 'refs/pull/77/head')).toBe(pull);
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('head-on-remote');
    expect(result.exitCode).toBe(0);
    expect(existsSync(f.copy)).toBe(false);
  });

  test('a local tag is published when a remote tag advertises its commit', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'tagged');
    writeFileSync(join(f.copy, 'product.txt'), 'remote tagged product\n');
    git(f.copy, 'commit', '-qam', 'remote tagged product');
    const sha = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'tag', 'v-local');
    git(f.copy, 'push', '-q', 'origin', `${sha}:refs/tags/v-remote`);
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'branch', '-D', 'tagged');
    expect(git(f.remote, 'rev-parse', 'refs/tags/v-remote')).toBe(sha);
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('head-on-remote');
    expect(result.exitCode).toBe(0);
    expect(existsSync(f.copy)).toBe(false);
  });

  test('docs-only commits on non-HEAD branches are preserved before removal', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'wip-notes');
    writeFileSync(join(f.copy, 'handoffs', 'wip.md'), 'wip report\n');
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', 'wip report');
    const wip = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'checkout', '-q', '-b', 'docs-notes');
    writeFileSync(join(f.copy, 'docs', 'other.md'), 'other docs\n');
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', 'other docs');
    const docs = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('local-only-handoffs');
    expect(existsSync(f.copy)).toBe(false);
    expect(readFileSync(join(f.preserve, 'copy', 'handoffs', 'wip.md'), 'utf8'))
      .toBe('wip report\n');
    expect(readFileSync(join(f.preserve, 'copy', 'docs', 'other.md'), 'utf8'))
      .toBe('other docs\n');
    const record = readFileSync(join(f.preserve, 'copy', '.wish-reap-commits.txt'), 'utf8');
    expect(record).toContain(wip);
    expect(record).toContain(docs);
    expect(result.exitCode).toBe(0);
  });

  test('every *.lock under .git keeps the copy, and locks alone exit 0', () => {
    const f = copyOf();
    const cases: Array<[string, string]> = [
      ['index', '.git/index.lock'],
      ['head', '.git/HEAD.lock'],
      ['config', '.git/config.lock'],
      ['packed', '.git/packed-refs.lock'],
      ['ref', '.git/refs/heads/wish.lock'],
      ['shallow', '.git/shallow.lock'],
    ];
    for (const [name, lock] of cases) {
      const copy = join(f.root, name);
      git(f.dir, 'clone', '-q', f.remote, copy);
      mkdirSync(dirname(join(copy, lock)), { recursive: true });
      writeFileSync(join(copy, lock), '');
      backdate(copy);
    }
    rmSync(f.copy, { recursive: true, force: true });
    const dry = reap(parseArgs(['--root', f.root, '--preserve', f.preserve]));
    expect(dry.copies).toHaveLength(cases.length);
    for (const [name, lock] of cases) {
      const entry = dry.copies.find((item: { name: string }) => item.name === name);
      expect(entry?.decision).toBe('keep');
      expect(entry?.reason).toBe('locked');
      expect(entry?.detail).toContain(lock.slice('.git/'.length));
    }
    expect(dry.exitCode).toBe(0);
    const applied = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(applied.summary.removed).toBe(0);
    for (const [name] of cases) expect(existsSync(join(f.root, name))).toBe(true);
  });

  test('a failed removal exits 3, not 1, and is not reported as lost work', () => {
    const f = copyOf();
    backdate(f.copy);
    chmodSync(f.copy, 0o500);
    let result;
    try {
      result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    } finally {
      chmodSync(f.copy, 0o700);
    }
    expect(result.copies[0].decision).toBe('keep');
    expect(result.copies[0].reason).toBe('remove-failed');
    expect(result.copies[0].error).toBe(true);
    expect(result.summary.keptForLostWork).toEqual([]);
    expect(result.summary.removalErrors).toEqual(['copy']);
    expect(result.exitCode).toBe(3);
  });
});

describe('wish-reap: preserve what is not a regular file', () => {
  /** A copy whose only unpublished work is a commit on `notes`, HEAD back on dev. */
  function reportOnlyCopy() {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'copy');
    git(dir, 'clone', '-q', remote, copy);
    git(copy, 'checkout', '-q', '-b', 'notes');
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  /** Commit a symlink at `path` on the current (local-only) branch; return the commit. */
  function commitLink(copy: string, path: string, target: string) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    symlinkSync(target, join(copy, path));
    git(copy, 'add', '-A');
    git(copy, 'commit', '-qm', `local link ${path}`);
    return git(copy, 'rev-parse', 'HEAD');
  }

  function commitReport(copy: string) {
    writeFileSync(join(copy, 'handoffs', 'local.md'), 'local report\n');
    git(copy, 'add', '-A');
    git(copy, 'commit', '-qm', 'local report');
    return git(copy, 'rev-parse', 'HEAD');
  }

  test('a symlink to a file inside the copy is preserved as a link', () => {
    const f = reportOnlyCopy();
    const sha = commitLink(f.copy, 'handoffs/inside-link', '../product.txt');
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('local-only-handoffs');
    expect(result.exitCode).toBe(0);
    const link = join(f.preserve, 'copy', 'handoffs', 'inside-link');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../product.txt');
    expect(readFileSync(join(f.preserve, 'copy', '.wish-reap-commits.txt'), 'utf8'))
      .toContain(sha);
  });

  test('a dangling symlink is preserved as a link with its target', () => {
    const f = reportOnlyCopy();
    commitLink(f.copy, 'handoffs/dangling', 'missing.md');
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(result.copies[0].decision).toBe('remove');
    const link = join(f.preserve, 'copy', 'handoffs', 'dangling');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('missing.md');
  });

  test('a symlink with an absolute target outside the copy is carried as a link', () => {
    const f = reportOnlyCopy();
    const outside = join(f.dir, 'outside.txt');
    writeFileSync(outside, 'outside\n');
    commitLink(f.copy, 'handoffs/absolute', outside);
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(result.copies[0].decision).toBe('remove');
    const link = join(f.preserve, 'copy', 'handoffs', 'absolute');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(outside);
  });

  test('a FIFO keeps the copy and names the path and kind', () => {
    const f = reportOnlyCopy();
    commitReport(f.copy);
    git(f.copy, 'checkout', '-q', 'dev');
    writeFileSync(join(f.copy, '.git', 'info', 'exclude'), 'pipe.fifo\n');
    const fifo = join(f.copy, 'handoffs', 'pipe.fifo');
    const made = spawnSync('mkfifo', [fifo]);
    expect(made.status).toBe(0);
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpreservable');
    expect(entry.detail).toContain('handoffs/pipe.fifo');
    expect(entry.detail).toContain('fifo');
    expect(result.summary.keptForLostWork).toEqual(['copy']);
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
    expect(existsSync(fifo)).toBe(true);
  });

  test('an empty directory that holds a symlink is preserved with its link', () => {
    const f = reportOnlyCopy();
    commitLink(f.copy, 'handoffs/empty/deep-link', '../local.md');
    mkdirSync(join(f.copy, 'handoffs', 'blank'));
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    expect(result.copies[0].decision).toBe('remove');
    const dir = join(f.preserve, 'copy', 'handoffs', 'empty');
    expect(lstatSync(dir).isDirectory()).toBe(true);
    const link = join(dir, 'deep-link');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../local.md');
    expect(lstatSync(join(f.preserve, 'copy', 'handoffs', 'blank')).isDirectory()).toBe(true);
  });

  test('an ignored working-tree symlink is carried before a head-on-remote copy goes', () => {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'copy');
    git(dir, 'clone', '-q', remote, copy);
    writeFileSync(join(copy, '.git', 'info', 'exclude'), 'ignored-link\n');
    symlinkSync('../product.txt', join(copy, 'handoffs', 'ignored-link'));
    backdate(copy);
    const preserve = join(dir, 'preserved');
    const result = reap(parseArgs(['--root', root, '--preserve', preserve, '--apply']));
    expect(result.copies[0].decision).toBe('remove');
    expect(result.copies[0].reason).toBe('head-on-remote');
    expect(result.exitCode).toBe(0);
    const link = join(preserve, 'copy', 'handoffs', 'ignored-link');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../product.txt');
    expect(existsSync(join(preserve, 'copy', '.wish-reap-commits.txt'))).toBe(false);
  });
});

/** Run `fn` with environment overrides, restoring every key (present or absent) afterwards. */
function withEnv<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved = Object.entries(overrides).map(([key, value]) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The identity the fixture's own commits use; the in-process reaper's git calls need it too. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/**
 * A `git` shim placed first on PATH. It counts `status` calls and, on the second one, either
 * fails (the pre-removal recheck) or stashes a product change first (work that appears between
 * the decision and the removal).
 */
function gitShim(dir: string) {
  const shimDir = join(dir, 'shim');
  mkdirSync(shimDir);
  const count = join(shimDir, 'count');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh
is_status=0
for arg in "$@"; do
  [ "$arg" = status ] && is_status=1
done
if [ "$is_status" = 1 ]; then
  n=$(cat "$WISH_REAP_SHIM_COUNT" 2>/dev/null || printf 0)
  n=$((n + 1))
  printf '%s\\n' "$n" > "$WISH_REAP_SHIM_COUNT"
  if [ "$n" -ge 2 ]; then
    case "$WISH_REAP_SHIM_ACTION" in
      fail-status)
        printf 'shim: status failed\\n' >&2
        exit 128
        ;;
      stash)
        printf 'shim stashed product\\n' > product.txt
        ${JSON.stringify(real)} stash push -q -m 'shim stash' >/dev/null 2>&1 || true
        ;;
    esac
  fi
fi
exec ${JSON.stringify(real)} "$@"
`);
  chmodSync(join(shimDir, 'git'), 0o755);
  return { shimDir, count };
}

/** Reap in-process with the git shim first on PATH. */
function reapWithShim(fixture: { root: string; preserve: string }, shim: { shimDir: string;
  count: string }, action: string, extra: string[] = []) {
  return withEnv({
    ...IDENTITY,
    PATH: `${shim.shimDir}:${process.env.PATH ?? ''}`,
    WISH_REAP_SHIM_COUNT: shim.count,
    WISH_REAP_SHIM_ACTION: action,
  }, () => reap(parseArgs(['--root', fixture.root, '--preserve', fixture.preserve,
    '--apply', ...extra])));
}

describe('wish-reap: a stash or a note is work too', () => {
  /** A clean copy under its own root; the fake remote only advertises its seed commit. */
  function copyOf(name = 'copy') {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, name);
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  test('a git stash holding a product change keeps the copy and names refs/stash', () => {
    const f = copyOf();
    writeFileSync(join(f.copy, 'product.txt'), 'stashed product\n');
    git(f.copy, 'stash', 'push', '-m', 'product work');
    expect(git(f.copy, 'stash', 'list')).toContain('product work');
    expect(git(f.copy, 'status', '--porcelain')).toBe('');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpublished');
    expect(entry.detail).toContain('refs/stash');
    expect(result.exitCode).toBe(1);
    expect(result.summary.keptForLostWork).toEqual(['copy']);
    expect(existsSync(f.copy)).toBe(true);
    expect(git(f.copy, 'stash', 'list')).toContain('product work');
    expect(readFileSync(join(f.copy, 'product.txt'), 'utf8')).toBe('one\n');
  });

  test('a refs/notes/commits entry keeps the copy and names the ref', () => {
    const f = copyOf();
    git(f.copy, 'notes', 'add', '-m', 'a local note', 'HEAD');
    const note = git(f.copy, 'rev-parse', 'refs/notes/commits');
    expect(note).toMatch(/^[0-9a-f]{40}$/);
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpublished');
    expect(entry.detail).toContain('refs/notes/commits');
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
    expect(git(f.copy, 'rev-parse', 'refs/notes/commits')).toBe(note);
  });

  test('a note the remote advertises is published and the copy goes', () => {
    const f = copyOf();
    git(f.copy, 'notes', 'add', '-m', 'a published note', 'HEAD');
    git(f.copy, 'push', '-q', 'origin', 'refs/notes/commits');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('head-on-remote');
    expect(result.exitCode).toBe(0);
    expect(existsSync(f.copy)).toBe(false);
  });

  test('a stale refs/remotes ref is cache, not local work, and does not keep the copy', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'gone');
    writeFileSync(join(f.copy, 'product.txt'), 'gone product\n');
    git(f.copy, 'commit', '-qam', 'gone product');
    const gone = git(f.copy, 'rev-parse', 'HEAD');
    git(f.copy, 'push', '-q', 'origin', 'gone');
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'branch', '-D', 'gone');
    git(f.remote, 'branch', '-D', 'gone');
    git(f.copy, 'update-ref', 'refs/remotes/origin/gone', gone);
    expect(git(f.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'))
      .toBe('refs/heads/dev');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('head-on-remote');
    expect(result.exitCode).toBe(0);
    expect(existsSync(f.copy)).toBe(false);
  });

  test('a stash created between the decision and the removal keeps the copy', () => {
    const f = copyOf();
    backdate(f.copy);
    const shim = gitShim(f.dir);
    // `--idle-minutes 0` so the freshly made stash is caught by the ref scan, not by `recent`.
    const result = reapWithShim(f, shim, 'stash', ['--idle-minutes', '0']);
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('unpublished');
    expect(entry.detail).toContain('refs/stash');
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
    expect(git(f.copy, 'stash', 'list')).toContain('shim stash');
  });
});

describe('wish-reap: a failure to read is not an empty copy', () => {
  function copyOf(name = 'copy') {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, name);
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  test('a git status failure on the pre-removal recheck keeps the copy and exits 3', () => {
    const f = copyOf();
    backdate(f.copy);
    const shim = gitShim(f.dir);
    const result = reapWithShim(f, shim, 'fail-status');
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('inspection-failed');
    expect(entry.detail).toContain('recheck');
    expect(entry.readFailure).toBe(true);
    expect(entry.lostWork).toBe(false);
    expect(result.summary.readErrors).toEqual(['copy']);
    expect(result.summary.keptForLostWork).toEqual([]);
    expect(result.exitCode).toBe(3);
    expect(existsSync(f.copy)).toBe(true);
    expect(readFileSync(join(f.copy, 'product.txt'), 'utf8')).toBe('one\n');
  });

  test('an unreadable handoffs/ during inspection keeps the copy and exits 3', () => {
    const f = copyOf();
    backdate(f.copy);
    const handoffs = join(f.copy, 'handoffs');
    chmodSync(handoffs, 0o000);
    let result;
    try {
      result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    } finally {
      chmodSync(handoffs, 0o755);
    }
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('inspection-failed');
    expect(entry.detail).toContain('handoffs');
    expect(entry.readFailure).toBe(true);
    expect(result.summary.readErrors).toEqual(['copy']);
    expect(result.exitCode).toBe(3);
    expect(existsSync(f.copy)).toBe(true);
  });

  test('a read failure during inspection is never counted as kept lost work', () => {
    const f = copyOf();
    backdate(f.copy);
    const docs = join(f.copy, 'docs');
    chmodSync(docs, 0o000);
    let result;
    try {
      result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve]));
    } finally {
      chmodSync(docs, 0o755);
    }
    expect(result.copies[0].readFailure).toBe(true);
    expect(result.summary.keptForLostWork).toEqual([]);
    expect(result.exitCode).toBe(3);
  });
});

describe('wish-reap: two refs, one preserved path', () => {
  function copyOf() {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'copy');
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  /** Commit a docs change with a fixed committer time, so "newest" is not wall-clock luck. */
  function commitDocs(copy: string, body: string, when: string) {
    writeFileSync(join(copy, 'docs', 'note.md'), body);
    git(copy, 'add', '-A');
    execFileSync('git', ['commit', '-qm', `docs ${body.trim()}`], {
      cwd: copy, encoding: 'utf8', stdio: 'pipe',
      env: { ...ENV, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
    });
    return git(copy, 'rev-parse', 'HEAD');
  }

  test('the newest ref wins the same docs path instead of the last visited one', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'a-older');
    const older = commitDocs(f.copy, 'older\n', '2026-01-01T00:00:00 +0000');
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'checkout', '-q', '-b', 'z-newer');
    const newer = commitDocs(f.copy, 'newest\n', '2026-06-01T00:00:00 +0000');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('remove');
    expect(entry.reason).toBe('local-only-handoffs');
    expect(readFileSync(join(f.preserve, 'copy', 'docs', 'note.md'), 'utf8')).toBe('newest\n');
    const record = readFileSync(join(f.preserve, 'copy', '.wish-reap-commits.txt'), 'utf8');
    expect(record).toContain(older);
    expect(record).toContain(newer);
    expect(result.exitCode).toBe(0);
  });

  test('the same docs path at the same commit time keeps the copy and names both refs', () => {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', 'a-same');
    commitDocs(f.copy, 'same time a\n', '2026-03-01T00:00:00 +0000');
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'checkout', '-q', '-b', 'z-same');
    commitDocs(f.copy, 'same time z\n', '2026-03-01T00:00:00 +0000');
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('preserve-conflict');
    expect(entry.detail).toContain('docs/note.md');
    expect(entry.detail).toContain('refs/heads/a-same');
    expect(entry.detail).toContain('refs/heads/z-same');
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
  });
});

describe('wish-reap: a file cannot share a path with anything below it', () => {
  function copyOf() {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'copy');
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  /** One local branch adds `handoffs/shared` as a file, one adds `handoffs/shared/x.md`. */
  function fileVsChild(fileRef: string, childRef: string) {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', fileRef, 'dev');
    writeFileSync(join(f.copy, 'handoffs', 'shared'), 'the file\n');
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', `file ${fileRef}`);
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'checkout', '-q', '-b', childRef, 'dev');
    mkdirSync(join(f.copy, 'handoffs', 'shared'));
    writeFileSync(join(f.copy, 'handoffs', 'shared', 'x.md'), 'the child\n');
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', `child ${childRef}`);
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    return f;
  }

  function expectKept(f: ReturnType<typeof fileVsChild>, fileRef: string, childRef: string) {
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('preserve-conflict');
    expect(entry.detail).toContain('handoffs/shared');
    expect(entry.detail).toContain(`refs/heads/${fileRef}`);
    expect(entry.detail).toContain(`refs/heads/${childRef}`);
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
    // Nothing was written into the preserve tree: the conflict was caught before it could
    // silently pick a side.
    expect(existsSync(join(f.preserve, 'copy'))).toBe(false);
  }

  test('a file named before the child ref keeps the copy, naming both refs', () => {
    const f = fileVsChild('a-file', 'z-child');
    expectKept(f, 'a-file', 'z-child');
  });

  test('the same conflict with the ref names reversed also keeps the copy', () => {
    const f = fileVsChild('z-file', 'a-child');
    expectKept(f, 'z-file', 'a-child');
  });
});

describe('wish-reap: a same-path mode difference is a conflict too', () => {
  function copyOf() {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'copy');
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  /** The same bytes on two local branches, one executable and one not. */
  function modeBranches(execRef: string, plainRef: string) {
    const f = copyOf();
    git(f.copy, 'checkout', '-q', '-b', execRef, 'dev');
    writeFileSync(join(f.copy, 'docs', 'note.md'), 'same bytes\n');
    chmodSync(join(f.copy, 'docs', 'note.md'), 0o755);
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', `executable ${execRef}`);
    git(f.copy, 'checkout', '-q', 'dev');
    git(f.copy, 'checkout', '-q', '-b', plainRef, 'dev');
    writeFileSync(join(f.copy, 'docs', 'note.md'), 'same bytes\n');
    chmodSync(join(f.copy, 'docs', 'note.md'), 0o644);
    git(f.copy, 'add', '-A');
    git(f.copy, 'commit', '-qm', `plain ${plainRef}`);
    git(f.copy, 'checkout', '-q', 'dev');
    backdate(f.copy);
    return f;
  }

  test('a mode-only same-path winner keeps the copy and names both refs', () => {
    const f = modeBranches('a-exec', 'z-plain');
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('preserve-conflict');
    expect(entry.detail).toContain('docs/note.md');
    expect(entry.detail).toContain('refs/heads/a-exec');
    expect(entry.detail).toContain('refs/heads/z-plain');
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
  });

  test('the mode conflict is the same with the ref names reversed', () => {
    const f = modeBranches('z-exec', 'a-plain');
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.reason).toBe('preserve-conflict');
    expect(entry.detail).toContain('docs/note.md');
    expect(entry.detail).toContain('refs/heads/z-exec');
    expect(entry.detail).toContain('refs/heads/a-plain');
    expect(result.exitCode).toBe(1);
    expect(existsSync(f.copy)).toBe(true);
  });
});

describe('wish-reap: a ref that does not resolve to a commit', () => {
  function copyOf() {
    const { dir, remote } = remoteFixture();
    const root = join(dir, 'copies');
    mkdirSync(root);
    const copy = join(root, 'copy');
    git(dir, 'clone', '-q', remote, copy);
    return { dir, remote, root, copy, preserve: join(dir, 'preserved') };
  }

  test('a dangling local ref keeps the copy with a read failure instead of being skipped', () => {
    const f = copyOf();
    writeFileSync(join(f.copy, '.git', 'refs', 'heads', 'broken'), `${'0'.repeat(40)}\n`);
    backdate(f.copy);
    const result = reap(parseArgs(['--root', f.root, '--preserve', f.preserve, '--apply']));
    const entry = result.copies[0];
    expect(entry.decision).toBe('keep');
    expect(entry.readFailure).toBe(true);
    expect(entry.detail).toContain('refs/heads/broken');
    expect(result.summary.readErrors).toEqual(['copy']);
    expect(result.exitCode).toBe(3);
    expect(existsSync(f.copy)).toBe(true);
    expect(existsSync(join(f.copy, '.git', 'refs', 'heads', 'broken'))).toBe(true);
  });
});
