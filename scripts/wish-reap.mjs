#!/usr/bin/env node
/**
 * Reaps a finished wish's copy: the reaper for the copies under one project's wish folder
 * (issues #1695 and #1698). A plain clone is invisible to `git worktree prune`, so this walks
 * every direct child of --root that is a git checkout and removes it only when all gates hold:
 *
 *   1. clean       `git status --porcelain --untracked-files=all` is empty
 *   2. safe work   HEAD is advertised by the remote (a branch head or a pull-request head), or
 *                  every local-only commit touches only handoffs/ or docs/ and the files at
 *                  HEAD are copied into --preserve before the copy goes
 *   3. idle        nothing in the copy changed in the last --idle-minutes (default 30)
 *   4. unlocked    no index.lock, HEAD.lock or config.lock in the copy's git dir
 *
 * Removal is `git worktree remove` when the copy is a registered worktree of the shared clone
 * (--shared), otherwise `rm -rf` for a plain clone. It never forces. After worktree removals
 * the owner clone is pruned. The remote check is `git ls-remote`, so no forge API is needed.
 *
 *   node scripts/wish-reap.mjs [--root <dir>] [--idle-minutes <n>] [--preserve <dir>]
 *                              [--shared <dir>] [--remote <name>] [--apply] [--json]
 *
 * Dry run unless --apply: decisions are computed and printed, nothing is removed or copied.
 * --root defaults to $WISH_COPIES_ROOT, else the host's top-level wish folder; point it at one
 * project's folder, whose direct children are the copies. --preserve defaults to
 * <root>/.wish-preserved. One line per copy; --json prints the machine-readable list instead.
 * Exit 1 when a copy was kept for lost work (dirty, or unpublished product changes), else 0.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync,
  rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_IDLE_MINUTES = 30;
export const LOCK_FILES = ['index.lock', 'HEAD.lock', 'config.lock'];
export const PRESERVED_PREFIXES = ['handoffs', 'docs'];
export const PRESERVE_DIR = '.wish-preserved';
export const PRESERVE_RECORD = '.wish-reap-commits.txt';
const DEFAULT_ROOT = process.env.WISH_COPIES_ROOT
  ? resolve(process.env.WISH_COPIES_ROOT)
  : join(homedir(), '.automagik', 'bots', 'workspace', 'wishes');

const USAGE = `usage: node scripts/wish-reap.mjs [--root <dir>] [--idle-minutes <n>]
       [--preserve <dir>] [--shared <dir>] [--remote <name>] [--apply] [--json]`;

/** Run one git command in `cwd`; never throws, so a probe cannot lose the whole walk. */
function runGit(cwd, args, timeout = 120_000) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) return { ok: false, code: -1, out: '', err: result.error.message };
  return {
    ok: result.status === 0,
    code: result.status,
    out: (result.stdout ?? '').trimEnd(),
    err: (result.stderr ?? '').trim(),
  };
}

function readOptionValue(argv, index, arg) {
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    const value = arg.slice(eq + 1);
    if (!value) throw new Error(`${arg.slice(0, eq)} needs a value`);
    return { value, used: 0 };
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
  return { value, used: 1 };
}

/** Parse the CLI; exported so the test can run every gate without a subprocess. */
export function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    apply: false,
    json: false,
    help: false,
    idleMinutes: DEFAULT_IDLE_MINUTES,
    preserve: null,
    shared: null,
    remote: 'origin',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (flag === '--apply' || flag === '--json' || flag === '--help' || flag === '-h') {
      if (arg !== flag) throw new Error(`${flag} takes no value`);
      if (flag === '--help' || flag === '-h') options.help = true;
      else options[flag.slice(2)] = true;
      continue;
    }
    if (flag === '--root' || flag === '--preserve' || flag === '--shared' || flag === '--remote'
      || flag === '--idle-minutes') {
      const { value, used } = readOptionValue(argv, index, arg);
      index += used;
      if (flag === '--idle-minutes') {
        const minutes = Number(value);
        if (!Number.isFinite(minutes) || minutes < 0) {
          throw new Error('--idle-minutes must be a number >= 0');
        }
        options.idleMinutes = minutes;
      } else if (flag === '--remote') {
        if (!value) throw new Error('--remote needs a name');
        options.remote = value;
      } else {
        options[flag.slice(2)] = value;
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  options.root = resolve(options.root);
  options.preserve = options.preserve
    ? resolve(options.preserve)
    : join(options.root, PRESERVE_DIR);
  options.shared = options.shared ? resolve(options.shared) : null;
  return options;
}

function emptyEntry(copy) {
  return { name: basename(copy), path: copy, decision: 'keep', reason: 'kept', lostWork: false };
}

function keep(entry, reason, detail = null, lostWork = false) {
  entry.decision = 'keep';
  entry.reason = reason;
  if (detail) entry.detail = detail;
  entry.lostWork = lostWork;
  return entry;
}

function markForRemoval(entry, reason, options) {
  entry.decision = 'remove';
  entry.reason = reason;
  if (entry.preservePaths?.length) entry.preserveTo = join(options.preserve, entry.name);
  return entry;
}

/** Newest mtime and total bytes under `copy`, following no symlink; null when unreadable. */
function scanCopy(copy) {
  let newest = 0;
  let bytes = 0;
  const stack = [copy];
  try {
    while (stack.length) {
      const path = stack.pop();
      const info = lstatSync(path);
      if (info.mtimeMs > newest) newest = info.mtimeMs;
      if (info.isDirectory()) {
        for (const child of readdirSync(path)) stack.push(join(path, child));
      } else if (info.isFile()) {
        bytes += info.size;
      }
    }
  } catch {
    return null;
  }
  return { newest, bytes };
}

/** The refs a freshly asked remote advertises, cached by URL so one call serves every copy. */
function remoteRefs(copy, url, cache) {
  const local = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !url.startsWith('/');
  const key = `${local ? `${copy}\0` : ''}${url}`;
  if (!cache.has(key)) {
    const result = runGit(copy, ['ls-remote', url, 'refs/heads/*', 'refs/pull/*/head'], 60_000);
    if (!result.ok) {
      cache.set(key, { ok: false, error: result.err || `git ls-remote exited ${result.code}` });
    } else {
      const heads = new Set();
      const pulls = new Set();
      for (const line of result.out.split('\n')) {
        const [sha, ref] = line.split('\t');
        if (!sha || !ref) continue;
        if (ref.startsWith('refs/heads/')) heads.add(sha);
        else if (ref.startsWith('refs/pull/')) pulls.add(sha);
      }
      cache.set(key, { ok: true, heads, pulls });
    }
  }
  return cache.get(key);
}

function hasCommit(copy, sha) {
  return runGit(copy, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

function isAncestor(copy, ancestor, descendant) {
  return runGit(copy, ['merge-base', '--is-ancestor', ancestor, descendant]).ok;
}

/** `{ ok: true, via }` when the remote advertises HEAD or a branch head contains it. */
function headPublished(copy, head, refs) {
  if (refs.heads.has(head) || refs.pulls.has(head)) return { ok: true, via: 'ref' };
  for (const sha of refs.heads) {
    if (sha === head || !hasCommit(copy, sha)) continue;
    if (isAncestor(copy, head, sha)) return { ok: true, via: `ancestor of ${sha.slice(0, 12)}` };
  }
  return { ok: false };
}

/** Commits reachable from HEAD but not from any local remote-tracking ref; null on failure. */
function localOnlyCommits(copy, head) {
  const result = runGit(copy, ['rev-list', head, '--not', '--remotes']);
  if (!result.ok) return null;
  return result.out ? result.out.split('\n') : [];
}

/** Paths a commit changes; `{ merge: true }` when it is a merge and the diff is ambiguous. */
function commitPaths(copy, sha) {
  const parents = runGit(copy, ['rev-list', '--parents', '-n', '1', sha]);
  if (!parents.ok) return null;
  if (parents.out.trim().split(/\s+/).length > 2) return { merge: true, paths: [] };
  const shown = runGit(copy,
    ['show', '--pretty=format:', '--name-only', '--no-renames', '-z', sha]);
  if (!shown.ok) return null;
  return { merge: false, paths: shown.out.split('\0').filter(Boolean) };
}

function underPreserved(path) {
  return PRESERVED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function safeRelativePath(path) {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\0')
    && !path.split('/').includes('..');
}

/** The clone a common git dir belongs to: a normal clone's parent, or a bare clone itself. */
function cloneRoot(commonDir) {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

/** Whether `owner` lists `copy` among its registered worktrees. */
function registeredWorktree(owner, copy) {
  const listed = runGit(owner, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return false;
  let target;
  try {
    target = realpathSync(copy);
  } catch {
    return false;
  }
  for (const line of listed.out.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    try {
      if (realpathSync(line.slice('worktree '.length)) === target) return true;
    } catch {
      /* a stale entry is not a registration */
    }
  }
  return false;
}

/** `{ method: 'rm-rf' }`, `{ method: 'worktree-remove', owner }`, or `{ error, reason }`. */
function worktreeInfo(copy, options) {
  let dotGit;
  try {
    dotGit = lstatSync(join(copy, '.git'));
  } catch {
    return { error: 'no .git', reason: 'not-a-copy' };
  }
  if (dotGit.isDirectory()) return { method: 'rm-rf' };
  if (!dotGit.isFile()) return { error: '.git is neither a file nor a directory' };
  const gitDir = runGit(copy, ['rev-parse', '--git-dir']);
  const common = runGit(copy, ['rev-parse', '--git-common-dir']);
  if (!gitDir.ok || !common.ok) return { error: 'git dirs cannot be resolved' };
  if (resolve(copy, gitDir.out) === resolve(copy, common.out)) {
    return { error: '.git file without a separate common dir' };
  }
  const owner = options.shared ?? cloneRoot(resolve(copy, common.out));
  if (!registeredWorktree(owner, copy)) {
    return options.shared
      ? { error: `not a worktree of ${options.shared}`, reason: 'worktree-not-of-shared' }
      : { error: 'not a registered worktree of its clone', reason: 'worktree-unresolved' };
  }
  return { method: 'worktree-remove', owner };
}

/** Copy the local-only files out, then record the commits they came from. */
function preserveFiles(copy, entry, options) {
  const target = join(options.preserve, entry.name);
  try {
    for (const path of entry.preservePaths) {
      if (!safeRelativePath(path)) continue;
      const source = join(copy, path);
      let info;
      try {
        info = lstatSync(source);
      } catch {
        continue; // deleted by a later local commit
      }
      if (!info.isFile()) continue;
      const destination = join(target, path);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
      chmodSync(destination, info.mode & 0o777);
    }
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, PRESERVE_RECORD), `${entry.localCommits.join('\n')}\n`);
    return { ok: true, target };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Classify one copy. Every failure becomes a keep reason, never an exception. */
function inspect(copy, options, cache) {
  const entry = emptyEntry(copy);
  const gitDir = runGit(copy, ['rev-parse', '--git-dir']);
  if (!gitDir.ok) return keep(entry, 'inspection-failed', 'git dir cannot be resolved');
  const gitDirPath = resolve(copy, gitDir.out);
  const common = runGit(copy, ['rev-parse', '--git-common-dir']);
  const lockDirs = [...new Set([gitDirPath,
    common.ok ? resolve(copy, common.out) : gitDirPath])];
  const locks = [...new Set(lockDirs.flatMap((dir) => LOCK_FILES
    .filter((name) => existsSync(join(dir, name)))))];
  if (locks.length) return keep(entry, 'locked', `lock files: ${locks.join(', ')}`);
  const head = runGit(copy, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return keep(entry, 'no-head', 'HEAD does not resolve to a commit');
  entry.sha = head.out;
  const status = runGit(copy,
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return keep(entry, 'inspection-failed', status.err || 'git status failed');
  if (status.out) {
    return keep(entry, 'dirty', `${status.out.split('\n').length} changed path(s)`, true);
  }
  const scan = scanCopy(copy);
  if (!scan) return keep(entry, 'inspection-failed', 'copy cannot be read');
  entry.sizeBytes = scan.bytes;
  const age = Date.now() - scan.newest;
  if (age < options.idleMinutes * 60_000) {
    return keep(entry, 'recent', `modified ${Math.floor(age / 60_000)} min ago, ` +
      `needs ${options.idleMinutes} min idle`);
  }
  const url = runGit(copy, ['config', '--get', `remote.${options.remote}.url`]);
  if (!url.ok || !url.out) return keep(entry, 'no-remote', `no ${options.remote} remote`);
  const refs = remoteRefs(copy, url.out, cache);
  if (!refs.ok) return keep(entry, 'remote-check-failed', refs.error);
  const published = headPublished(copy, head.out, refs);
  if (published.ok) {
    const info = worktreeInfo(copy, options);
    if (info.error) return keep(entry, info.reason ?? 'worktree-unresolved', info.error);
    entry.method = info.method;
    if (info.owner) entry.owner = info.owner;
    return markForRemoval(entry, 'head-on-remote', options);
  }
  const local = localOnlyCommits(copy, head.out);
  if (!local) return keep(entry, 'inspection-failed', 'local-only commits cannot be listed');
  if (!local.length) {
    return keep(entry, 'unpublished', 'HEAD is not advertised by the remote', true);
  }
  const paths = new Set();
  const unsafe = [];
  for (const sha of local) {
    const changed = commitPaths(copy, sha);
    if (!changed) return keep(entry, 'inspection-failed', `cannot read ${sha.slice(0, 12)}`);
    if (changed.merge) {
      return keep(entry, 'unpublished', `local-only commit ${sha.slice(0, 12)} is a merge`, true);
    }
    for (const path of changed.paths) {
      if (underPreserved(path)) paths.add(path);
      else unsafe.push(`${sha.slice(0, 12)}:${path}`);
    }
  }
  if (unsafe.length) {
    return keep(entry, 'unpublished', `local-only product change ${unsafe[0]}`, true);
  }
  const info = worktreeInfo(copy, options);
  if (info.error) return keep(entry, info.reason ?? 'worktree-unresolved', info.error);
  entry.method = info.method;
  if (info.owner) entry.owner = info.owner;
  entry.localCommits = local;
  entry.preservePaths = [...paths].sort();
  return markForRemoval(entry, 'local-only-handoffs', options);
}

/** Re-run the cheap gates on a plain clone just before rm -rf; git re-checks a worktree. */
function recheck(entry) {
  if (entry.method !== 'rm-rf') return null;
  const gitDir = runGit(entry.path, ['rev-parse', '--git-dir']);
  if (!gitDir.ok) return { reason: 'inspection-failed', detail: 'recheck: git dir unreadable' };
  const common = runGit(entry.path, ['rev-parse', '--git-common-dir']);
  const dirs = [...new Set([resolve(entry.path, gitDir.out),
    common.ok ? resolve(entry.path, common.out) : resolve(entry.path, gitDir.out)])];
  for (const dir of dirs) {
    for (const name of LOCK_FILES) {
      if (existsSync(join(dir, name))) {
        return { reason: 'locked', detail: 'recheck: lock appeared' };
      }
    }
  }
  const status = runGit(entry.path,
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) return { reason: 'inspection-failed', detail: 'recheck: git status failed' };
  if (status.out) return { reason: 'dirty', detail: 'changed while reaping', lostWork: true };
  return null;
}

function removeEntry(entry) {
  if (entry.method === 'worktree-remove') {
    const result = runGit(entry.owner, ['worktree', 'remove', entry.path]);
    if (!result.ok) {
      return { ok: false, error: result.err || `git worktree remove exited ${result.code}` };
    }
    return { ok: true, owner: entry.owner };
  }
  try {
    rmSync(entry.path, { recursive: true, force: false });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Reap once; returns the JSON model plus the exit code the CLI uses. */
export function reap(options) {
  if (!existsSync(options.root) || !statSync(options.root).isDirectory()) {
    throw new Error(`root is not a directory: ${options.root}`);
  }
  const cache = new Map();
  const copies = [];
  for (const name of readdirSync(options.root).sort()) {
    const copy = join(options.root, name);
    let info;
    try {
      info = lstatSync(copy);
    } catch {
      continue;
    }
    if (!info.isDirectory() || !existsSync(join(copy, '.git'))) continue;
    let entry;
    try {
      entry = inspect(copy, options, cache);
    } catch (error) {
      entry = keep(emptyEntry(copy), 'inspection-failed', error.message);
    }
    copies.push(entry);
  }
  const pruned = [];
  const pruneErrors = [];
  if (options.apply) {
    const owners = new Set();
    for (const entry of copies) {
      if (entry.decision !== 'remove') continue;
      const changed = recheck(entry);
      if (changed) {
        Object.assign(entry, {
          decision: 'keep', reason: changed.reason, detail: changed.detail,
          lostWork: Boolean(changed.lostWork),
        });
        continue;
      }
      if (entry.preservePaths?.length) {
        const preserved = preserveFiles(entry.path, entry, options);
        if (!preserved.ok) {
          Object.assign(entry, {
            decision: 'keep', reason: 'preserve-failed', detail: preserved.error, lostWork: true,
          });
          continue;
        }
        entry.preservedTo = preserved.target;
      }
      const removed = removeEntry(entry);
      if (!removed.ok) {
        Object.assign(entry,
          { decision: 'keep', reason: 'remove-failed', detail: removed.error, error: true });
        continue;
      }
      entry.removed = true;
      if (removed.owner) owners.add(removed.owner);
    }
    for (const owner of owners) {
      const result = runGit(owner, ['worktree', 'prune']);
      if (result.ok) pruned.push(owner);
      else pruneErrors.push(result.err || `git worktree prune exited ${result.code}`);
    }
  }
  const kept = copies.filter((entry) => entry.decision === 'keep');
  const errors = copies.some((entry) => entry.error) || pruneErrors.length > 0;
  const summary = {
    total: copies.length,
    remove: copies.filter((entry) => entry.decision === 'remove').length,
    keep: kept.length,
    removed: copies.filter((entry) => entry.removed).length,
    keptForLostWork: kept.filter((entry) => entry.lostWork).map((entry) => entry.name),
    pruned,
  };
  if (pruneErrors.length) summary.pruneErrors = pruneErrors;
  return {
    root: options.root,
    apply: options.apply,
    idleMinutes: options.idleMinutes,
    preserve: options.preserve,
    shared: options.shared,
    remote: options.remote,
    copies,
    summary,
    exitCode: summary.keptForLostWork.length > 0 || errors ? 1 : 0,
  };
}

function printHuman(result) {
  for (const entry of result.copies) {
    const action = entry.decision === 'remove'
      ? (result.apply ? 'remove' : 'would-remove')
      : 'keep';
    const detail = entry.detail ? ` (${entry.detail})` : '';
    const preserved = entry.preservedTo ? ` preserved-to=${entry.preservedTo}` : '';
    const method = entry.method ? ` via=${entry.method}` : '';
    console.log(`${action}\t${entry.name}\t${entry.reason}${detail}${method}${preserved}`);
  }
  const mode = result.apply ? '' : ' (dry run)';
  const lost = result.summary.keptForLostWork.length;
  const moved = result.apply ? result.summary.removed : result.summary.remove;
  const verb = result.apply ? 'removed' : 'to remove';
  console.log(`wish-reap: ${result.summary.total} copies, ${moved} ${verb}, ` +
    `${result.summary.keep} kept, ${lost} kept for lost work${mode}`);
}

const invoked = (() => {
  try {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invoked) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`wish-reap: ${error.message}\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }
  try {
    const result = reap(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exit(result.exitCode);
  } catch (error) {
    console.error(`wish-reap: ${error.message}`);
    process.exit(2);
  }
}
