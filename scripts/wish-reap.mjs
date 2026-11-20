#!/usr/bin/env node
/**
 * Reaps a finished wish's copy: the reaper for the copies under one project's wish folder
 * (issues #1695 and #1698). A plain clone is invisible to `git worktree prune`, so this walks
 * every direct child of --root that is a git checkout and removes it only when all gates hold:
 *
 *   1. clean       `git status --porcelain --untracked-files=all` is empty
 *   2. safe work   every commit reachable from every local ref under `refs/` (branches, tags,
 *                  `refs/stash`, `refs/notes/*`, `refs/replace/*`, and anything else there
 *                  except `refs/remotes/*`) and HEAD is advertised by the remote as it answers
 *                  `git ls-remote` now. `refs/remotes/*` is deliberately excluded: a
 *                  remote-tracking ref is this clone's cached copy of an answer the remote gave
 *                  earlier, not the remote's current advertisement. Trusting one as "published"
 *                  could hide a commit the remote no longer has, and it can never hold work that
 *                  exists only here, so it is neither proof nor loss. A copy whose local-only
 *                  commits all touch only handoffs/ or docs/ is report-only: those files are
 *                  copied into --preserve before the copy goes. A symlink is carried as a link,
 *                  never as its target's bytes. FIFOs, sockets and devices cannot be carried, so
 *                  a copy that holds one is kept and the path and kind are named. Two refs that
 *                  disagree about a path keep the copy instead of letting the visit order pick
 *                  a side: a file on one ref where another needs a directory (or anything below
 *                  that path), the same path with a different mode, or the same path with
 *                  different bytes at the same commit time all name the path and both refs. The
 *                  rule is order-independent; identical bytes and mode at the same path are one
 *                  fact and need no choice
 *   3. idle        nothing in the copy changed in the last --idle-minutes (default 30)
 *   4. unlocked    no `*.lock` file anywhere under the copy's git dir or common dir
 *
 * Before --apply removes a copy it repeats the whole scan (refs included), so a stash or note
 * made between the decision and the removal keeps the copy. A failure to read the copy at any
 * point keeps it and exits 3: an unreadable copy is never "nothing to lose".
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
 * Exit 0 clean; 1 a copy was kept for lost work (dirty, or unpublished product changes);
 * 2 invalid usage; 3 a copy could not be read, preserved, removed or pruned. A read failure
 * exits 3 even though the copy is kept, and is reported apart from kept lost work.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync,
  rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_IDLE_MINUTES = 30;
/** Named for callers and docs; the gate itself finds every `*.lock` under the git dirs. */
export const LOCK_FILES = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock',
  'shallow.lock'];
export const EXIT = { ok: 0, lostWork: 1, usage: 2, failure: 3 };
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

/** Run one git command in `cwd` and keep stdout as bytes (preserved files need that). */
function runGitBuffer(cwd, args, timeout = 120_000) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) return { ok: false, code: -1, out: Buffer.alloc(0), err: result.error.message };
  return {
    ok: result.status === 0,
    code: result.status,
    out: result.stdout ?? Buffer.alloc(0),
    err: (result.stderr ?? Buffer.alloc(0)).toString().trim(),
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

/**
 * Keep because the copy could not be read: unlike lost work, this is not a verdict about what
 * the copy holds, and it exits 3. The entry is still a keep, never a removal.
 */
function keepUnreadable(entry, reason, detail = null) {
  keep(entry, reason, detail, false);
  entry.error = true;
  entry.readFailure = true;
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

/**
 * What the remote advertises right now, cached by URL so one call serves every copy. Every ref
 * the remote answers counts: branch heads, tags (including the peeled entries `ls-remote` prints
 * for annotated tags), pull-request heads, and notes or replace refs when the remote carries
 * them. Nothing here reads a local remote-tracking ref.
 */
function remoteRefs(copy, url, cache) {
  const local = !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url) && !url.startsWith('/');
  const key = `${local ? `${copy}\0` : ''}${url}`;
  if (!cache.has(key)) {
    const result = runGit(copy, ['ls-remote', url], 60_000);
    if (!result.ok) {
      cache.set(key, { ok: false, error: result.err || `git ls-remote exited ${result.code}` });
    } else {
      const advertised = new Set();
      for (const line of result.out.split('\n')) {
        const [sha, ref] = line.split('\t');
        if (sha && ref) advertised.add(sha);
      }
      cache.set(key, { ok: true, advertised });
    }
  }
  return cache.get(key);
}

/** Advertised commits this copy actually has; only those can bound a `rev-list --not`. */
function existingCommits(copy, shas) {
  const unique = [...new Set(shas)];
  if (!unique.length) return new Set();
  const result = spawnSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: copy,
    input: `${unique.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  const present = new Set();
  if (result.error || result.status !== 0) return present; // nothing proven published
  for (const line of (result.stdout ?? '').split('\n')) {
    const [sha, type] = line.trim().split(/\s+/);
    if (sha && type === 'commit') present.add(sha);
  }
  return present;
}

/**
 * Every local ref that resolves to a commit, plus HEAD itself; `{ error }` on failure or on a
 * ref that does not resolve to a commit. Everything under `refs/` counts, so a stash, a note and
 * a replace ref cannot hide unpublished work, except `refs/remotes/*`: those are cached copies of
 * an earlier remote answer, not the remote's current advertisement. Trusting one could hide a
 * commit the remote no longer has, and one cannot hold work that exists only locally, so it is
 * neither proof of publication nor lost work. A dangling ref (or one pointing at a tree or blob)
 * was silently skipped before, which let a copy whose only trace of work was that ref be removed;
 * it now keeps the copy as a read failure.
 */
function localRefs(copy, head) {
  const listed = runGit(copy, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/']);
  if (!listed.ok) return { error: listed.err || 'local refs cannot be listed' };
  // `for-each-ref` drops a ref whose object is missing and warns on stderr. A ref that cannot
  // be resolved is a ref whose work cannot be read, so the copy is kept rather than skipped.
  // `refs/remotes/*` stays cache even when it is broken: it is not local work.
  const broken = [...listed.err.matchAll(/ignoring broken ref (\S+)/g)]
    .map((match) => match[1])
    .filter((ref) => !ref.startsWith('refs/remotes/'));
  if (broken.length) {
    return { error: `ref ${broken[0]} does not resolve to a commit` };
  }
  const refs = [];
  const seen = new Set();
  for (const line of listed.out.split('\n')) {
    const [ref, sha] = line.split(' ');
    if (!ref || !sha) continue;
    if (ref.startsWith('refs/remotes/')) continue;
    const commit = runGit(copy, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (!commit.ok) {
      // A ref can exist and point at a tree or a blob; that is still not readable as commits.
      const object = runGit(copy, ['rev-parse', '--verify', ref]);
      const type = object.ok ? runGit(copy, ['cat-file', '-t', object.out]) : null;
      const kind = type?.ok ? ` (it points to a ${type.out})` : '';
      return { error: `ref ${ref} does not resolve to a commit${kind}` };
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push({ ref, sha: commit.out });
  }
  refs.push({ ref: 'HEAD', sha: head });
  return { refs };
}

/** Commits reachable from `sha` that no advertised commit reaches; null on failure. */
function localOnlyCommits(copy, sha, advertised) {
  const args = ['rev-list', sha];
  if (advertised.size) args.push('--not', ...advertised);
  const result = runGit(copy, args);
  if (!result.ok) return null;
  return result.out ? result.out.split('\n') : [];
}

/** The ref to name when a commit is at fault; prefer a real branch/tag over HEAD. */
function preferredRef(refs) {
  const list = [...(refs ?? [])];
  return list.find((ref) => ref !== 'HEAD') ?? 'HEAD';
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

/** Every `*.lock` below `dir`, as paths relative to it; symlinks are listed, never followed. */
function findLocks(dir) {
  const found = [];
  const stack = [{ abs: dir, rel: '' }];
  while (stack.length) {
    const { abs, rel } = stack.pop();
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.endsWith('.lock')) found.push(path);
      if (entry.isDirectory()) stack.push({ abs: join(abs, entry.name), rel: path });
    }
  }
  return found;
}

/** The locks in any of these git dirs; `git_dir` is often nested under `common_dir`. */
function locksIn(dirs) {
  return [...new Set(dirs.flatMap(findLocks))].sort();
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

/** The git tree entry at `sha:path`; `missing` when the commit does not have that path. */
function treeEntryAt(copy, sha, path) {
  const tree = runGit(copy, ['ls-tree', '-z', sha, '--', path]);
  if (!tree.ok) return { error: `cannot read ${sha.slice(0, 12)}:${path}` };
  const record = tree.out.split('\0').find(Boolean);
  if (!record) return { missing: true };
  const match = /^(\d{6}) (\w+) ([0-9a-f]+)\t/.exec(record);
  if (!match) return { error: `cannot read ${sha.slice(0, 12)}:${path}` };
  return { mode: match[1], type: match[2], object: match[3] };
}

/**
 * The blob `path` had at `sha`; `missing` when the commit did not change it to a blob. A symlink
 * is its target path, never the target's bytes. A submodule gitlink or an unknown mode is
 * `unsupported`: it cannot be carried into the preserve tree and keeping the copy is the answer.
 */
function blobAt(copy, sha, path) {
  const entry = treeEntryAt(copy, sha, path);
  if (entry.error) return { error: entry.error };
  if (entry.missing) return { missing: true };
  if (entry.type === 'commit') return { unsupported: 'submodule' };
  if (entry.type !== 'blob') return { unsupported: entry.type };
  const blob = runGitBuffer(copy, ['cat-file', 'blob', entry.object]);
  if (!blob.ok) return { error: `cannot read blob of ${sha.slice(0, 12)}:${path}` };
  if (entry.mode === '120000') return { symlink: blob.out.toString('utf8') };
  if (entry.mode === '100644' || entry.mode === '100755') {
    return { body: blob.out, mode: entry.mode === '100755' ? 0o755 : 0o644 };
  }
  return { unsupported: `mode-${entry.mode}` };
}

/** The kind of a working-tree entry that is neither a file, a directory nor a symlink. */
function entryKind(info) {
  if (info.isFIFO()) return 'fifo';
  if (info.isSocket()) return 'socket';
  if (info.isBlockDevice()) return 'block-device';
  if (info.isCharacterDevice()) return 'character-device';
  return 'unknown';
}

/**
 * What the working tree under handoffs/ and docs/ holds that git blobs cannot describe. Symlinks
 * are carried as links and an empty directory is recreated, because git cannot record either
 * fact. FIFOs, sockets, devices and anything else non-regular cannot be carried, so they are
 * reported for a keep instead of disappearing with the copy. Symlinks are never followed.
 */
function scanPreservedTree(copy) {
  const links = [];
  const emptyDirs = [];
  const unpreservable = [];
  for (const prefix of PRESERVED_PREFIXES) {
    const root = join(copy, prefix);
    let info;
    try {
      info = lstatSync(root);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      return { error: `cannot read ${prefix}: ${error.message}` };
    }
    if (info.isSymbolicLink()) {
      try {
        links.push({ path: prefix, target: readlinkSync(root) });
      } catch (error) {
        return { error: `cannot read link ${prefix}: ${error.message}` };
      }
      continue;
    }
    if (!info.isDirectory()) {
      if (!info.isFile()) unpreservable.push({ path: prefix, kind: entryKind(info) });
      continue;
    }
    const stack = [{ abs: root, rel: prefix }];
    while (stack.length) {
      const { abs, rel } = stack.pop();
      let children;
      try {
        children = readdirSync(abs);
      } catch (error) {
        return { error: `cannot read ${rel}: ${error.message}` };
      }
      if (!children.length) emptyDirs.push({ path: rel });
      for (const child of children) {
        const childPath = `${rel}/${child}`;
        const childAbs = join(abs, child);
        let childInfo;
        try {
          childInfo = lstatSync(childAbs);
        } catch (error) {
          return { error: `cannot read ${childPath}: ${error.message}` };
        }
        if (childInfo.isSymbolicLink()) {
          try {
            links.push({ path: childPath, target: readlinkSync(childAbs) });
          } catch (error) {
            return { error: `cannot read link ${childPath}: ${error.message}` };
          }
        } else if (childInfo.isDirectory()) {
          stack.push({ abs: childAbs, rel: childPath });
        } else if (!childInfo.isFile()) {
          unpreservable.push({ path: childPath, kind: entryKind(childInfo) });
        }
      }
    }
  }
  links.sort((a, b) => a.path.localeCompare(b.path));
  emptyDirs.sort((a, b) => a.path.localeCompare(b.path));
  unpreservable.sort((a, b) => a.path.localeCompare(b.path));
  return { links, emptyDirs, unpreservable };
}

/** The working-tree facts that must be copied into the preserve tree, as preserve entries. */
function worktreePreserved(special) {
  return [
    ...special.links.map(
      (link) => ({ source: 'worktree', path: link.path, kind: 'symlink', target: link.target })),
    ...special.emptyDirs.map(
      (dir) => ({ source: 'worktree', path: dir.path, kind: 'dir' })),
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/** The commit-preserved paths that are regular files or symlinks; an unsupported one is named. */
function classifyPreserved(copy, preserved) {
  const files = [];
  for (const item of preserved.values()) {
    const entry = treeEntryAt(copy, item.sha, item.path);
    if (entry.error) return { error: entry.error };
    if (entry.missing) continue;
    if (entry.type === 'commit') return { unsupported: { path: item.path, kind: 'submodule' } };
    if (entry.type !== 'blob') return { unsupported: { path: item.path, kind: entry.type } };
    if (entry.mode === '120000') files.push({ ...item, kind: 'symlink' });
    else if (entry.mode === '100644' || entry.mode === '100755') {
      files.push({ ...item, kind: 'file' });
    } else return { unsupported: { path: item.path, kind: `mode-${entry.mode}` } };
  }
  return { files };
}

/** The ref (or working tree) a preserve entry came from, for naming a conflict. */
function preservedSource(item) {
  if (item.source === 'worktree') return 'the working tree';
  return item.ref ?? 'HEAD';
}

/** A stable order for two preserve entries: path first, then the ref that carries it. */
function preserveOrder(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  const left = preservedSource(a);
  const right = preservedSource(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * One preserved path cannot also be a file (or a symlink) with paths below it: one ref may hold
 * a regular file where another holds a directory and a file inside it. Writing both made the
 * outcome depend on which ref was visited first -- usually the child's bytes were deleted by
 * removeAt to make room for the file, but the reverse order failed with EEXIST -- so the copy is
 * kept and both refs are named instead. The rule is order-independent: entries are sorted by
 * path and ref, and any non-directory entry whose path is a prefix of another entry's path is a
 * conflict, no matter how the refs are named or visited. Identical bytes at the same path are
 * not a conflict (they are one fact); a same path with a different mode is handled by
 * preservedWinner, which keeps the copy too. An empty directory is a directory, so a file may be
 * written below it.
 */
function preserveConflict(files) {
  const sorted = [...files].sort(preserveOrder);
  for (let index = 0; index < sorted.length; index += 1) {
    const ancestor = sorted[index];
    for (let next = index + 1; next < sorted.length; next += 1) {
      const descendant = sorted[next];
      if (descendant.path === ancestor.path) {
        if (descendant.kind === ancestor.kind) continue;
        return { path: ancestor.path, other: ancestor.path, ref: preservedSource(ancestor),
          otherRef: preservedSource(descendant), kind: ancestor.kind,
          otherKind: descendant.kind };
      }
      if (!descendant.path.startsWith(`${ancestor.path}/`)) continue;
      if (ancestor.kind === 'dir') continue;
      return { path: ancestor.path, other: descendant.path, ref: preservedSource(ancestor),
        otherRef: preservedSource(descendant), kind: ancestor.kind,
        otherKind: descendant.kind };
    }
  }
  return null;
}

/** Name a preserve conflict so both the path and the two refs appear in the detail. */
function describePreserveConflict(conflict) {
  if (conflict.kind === 'content') {
    return `${conflict.path} differs between ${conflict.ref} and ${conflict.otherRef} ` +
      'at the same commit time';
  }
  if (conflict.mode) {
    return `${conflict.path} has mode ${conflict.mode} on ${conflict.ref} and mode ` +
      `${conflict.otherMode} on ${conflict.otherRef}`;
  }
  if (conflict.other === conflict.path) {
    return `${conflict.path} is a ${conflict.kind} on ${conflict.ref} and a ` +
      `${conflict.otherKind} on ${conflict.otherRef}`;
  }
  return `${conflict.path} is a ${conflict.kind} on ${conflict.ref}, but ` +
    `${conflict.otherRef} needs a directory there for ${conflict.other}`;
}

/** The two sides of a same-path conflict, sorted by ref so the wording is order-independent. */
function modeConflict(path, current, a, candidate, b) {
  const sides = [
    { ref: preservedSource(current), mode: a.mode },
    { ref: preservedSource(candidate), mode: b.mode },
  ].sort((left, right) => (left.ref === right.ref ? 0 : left.ref < right.ref ? -1 : 1));
  return { path, ref: sides[0].ref, mode: sides[0].mode,
    otherRef: sides[1].ref, otherMode: sides[1].mode };
}

/**
 * A preserved path may be changed by commits on two different local refs. Carrying whichever was
 * visited last would silently choose one, so the newest committer time wins; equal times with
 * different bytes are ambiguous and the caller keeps the copy instead. Identical bytes and mode
 * need no choice. A different mode at the same path is a conflict like a file-versus-directory
 * one: it is kept with both refs named rather than silently picking the mode of the last ref
 * visited, whatever the commit times say.
 */
function preservedWinner(copy, current, candidate) {
  const a = treeEntryAt(copy, current.sha, current.path);
  const b = treeEntryAt(copy, candidate.sha, candidate.path);
  if (a.error) return { error: a.error };
  if (b.error) return { error: b.error };
  if (a.missing && b.missing) return { item: current };
  const both = a.object !== undefined && b.object !== undefined;
  if (both && a.mode !== b.mode) {
    return { conflict: modeConflict(current.path, current, a, candidate, b) };
  }
  if (both && a.object === b.object) return { item: current };
  const ta = commitTime(copy, current.sha);
  if (ta === null) return { error: `cannot read the commit time of ${current.sha.slice(0, 12)}` };
  const tb = commitTime(copy, candidate.sha);
  if (tb === null) {
    return { error: `cannot read the commit time of ${candidate.sha.slice(0, 12)}` };
  }
  if (tb > ta) return { item: candidate };
  if (ta > tb) return { item: current };
  return { conflict: { path: current.path, kind: 'content', ref: preservedSource(current),
    otherRef: preservedSource(candidate) } };
}

/** Committer time of a commit in seconds; null when it cannot be read. */
function commitTime(copy, sha) {
  const shown = runGit(copy, ['show', '-s', '--format=%ct', sha]);
  if (!shown.ok) return null;
  const seconds = Number(shown.out);
  return Number.isFinite(seconds) ? seconds : null;
}

/** The first symlink ancestor of `relative` inside `target`; writing below it would escape. */
function linkAncestor(target, relative) {
  let current = target;
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return current;
    } catch {
      return null; // the missing ancestor is created below the preserve target
    }
  }
  return null;
}

/** Remove whatever is at a preserve destination, never following a link. */
function removeAt(destination) {
  try {
    lstatSync(destination);
  } catch {
    return;
  }
  rmSync(destination, { recursive: true, force: true });
}

/** Copy the local-only files out of the commits themselves, then record those commits. */
function preserveFiles(copy, entry, options) {
  const target = join(options.preserve, entry.name);
  const files = entry.preserveFiles
    ?? (entry.preservePaths ?? []).map((path) => ({ sha: entry.sha, path }));
  try {
    for (const file of files) {
      if (!safeRelativePath(file.path)) continue;
      const destination = join(target, file.path);
      const blocker = linkAncestor(target, file.path);
      if (blocker) {
        return { ok: false, unsupported: true,
          error: `${file.path} (preserved link ${blocker} is in the way)` };
      }
      if (file.source === 'worktree') {
        if (file.kind === 'dir') {
          mkdirSync(destination, { recursive: true });
          continue;
        }
        mkdirSync(dirname(destination), { recursive: true });
        removeAt(destination);
        symlinkSync(file.target, destination);
        continue;
      }
      const blob = blobAt(copy, file.sha, file.path);
      if (blob.error) return { ok: false, error: blob.error };
      if (blob.unsupported) {
        return { ok: false, unsupported: true, error: `${file.path} (${blob.unsupported})` };
      }
      if (blob.missing) continue;
      mkdirSync(dirname(destination), { recursive: true });
      removeAt(destination);
      if (blob.symlink !== undefined) {
        symlinkSync(blob.symlink, destination);
      } else {
        writeFileSync(destination, blob.body);
        chmodSync(destination, blob.mode);
      }
    }
    mkdirSync(target, { recursive: true });
    if (entry.localCommits?.length) {
      writeFileSync(join(target, PRESERVE_RECORD), `${entry.localCommits.join('\n')}\n`);
    }
    return { ok: true, target };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/** Classify one copy. Every failure becomes a keep reason, never an exception. */
function inspect(copy, options, cache) {
  const entry = emptyEntry(copy);
  const gitDir = runGit(copy, ['rev-parse', '--git-dir']);
  if (!gitDir.ok) return keepUnreadable(entry, 'inspection-failed', 'git dir cannot be resolved');
  const gitDirPath = resolve(copy, gitDir.out);
  const common = runGit(copy, ['rev-parse', '--git-common-dir']);
  const lockDirs = [...new Set([gitDirPath,
    common.ok ? resolve(copy, common.out) : gitDirPath])];
  const locks = locksIn(lockDirs);
  if (locks.length) return keep(entry, 'locked', `lock files: ${locks.join(', ')}`);
  const head = runGit(copy, ['rev-parse', '--verify', 'HEAD']);
  if (!head.ok) return keepUnreadable(entry, 'no-head', 'HEAD does not resolve to a commit');
  entry.sha = head.out;
  const special = scanPreservedTree(copy);
  if (special.error) return keepUnreadable(entry, 'inspection-failed', special.error);
  if (special.unpreservable.length) {
    const first = special.unpreservable[0];
    return keep(entry, 'unpreservable', `${first.path} (${first.kind})`, true);
  }
  const status = runGit(copy,
    ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
  if (!status.ok) {
    return keepUnreadable(entry, 'inspection-failed', status.err || 'git status failed');
  }
  if (status.out) {
    return keep(entry, 'dirty', `${status.out.split('\n').length} changed path(s)`, true);
  }
  const scan = scanCopy(copy);
  if (!scan) return keepUnreadable(entry, 'inspection-failed', 'copy cannot be read');
  entry.sizeBytes = scan.bytes;
  const age = Date.now() - scan.newest;
  if (age < options.idleMinutes * 60_000) {
    return keep(entry, 'recent', `modified ${Math.floor(age / 60_000)} min ago, ` +
      `needs ${options.idleMinutes} min idle`);
  }
  const url = runGit(copy, ['config', '--get', `remote.${options.remote}.url`]);
  if (!url.ok || !url.out) return keep(entry, 'no-remote', `no ${options.remote} remote`);
  const refs = remoteRefs(copy, url.out, cache);
  if (!refs.ok) return keepUnreadable(entry, 'remote-check-failed', refs.error);
  const advertised = existingCommits(copy, refs.advertised);
  const localRefList = localRefs(copy, head.out);
  if (localRefList.error) {
    return keepUnreadable(entry, 'inspection-failed', localRefList.error);
  }
  const bySha = new Map();
  for (const { ref, sha } of localRefList.refs) {
    const commits = localOnlyCommits(copy, sha, advertised);
    if (!commits) {
      return keepUnreadable(entry, 'inspection-failed',
        `local-only commits of ${ref} cannot be listed`);
    }
    for (const commit of commits) {
      if (!bySha.has(commit)) bySha.set(commit, new Set());
      bySha.get(commit).add(ref);
    }
  }
  const local = [...bySha.keys()];
  if (!local.length) {
    if (special.links.length || special.emptyDirs.length) {
      const files = worktreePreserved(special);
      const conflict = preserveConflict(files);
      if (conflict) {
        return keep(entry, 'preserve-conflict', describePreserveConflict(conflict), true);
      }
      entry.localCommits = [];
      entry.preserveFiles = files;
      entry.preservePaths = files.map((file) => file.path).sort();
    }
    const info = worktreeInfo(copy, options);
    if (info.error) return keep(entry, info.reason ?? 'worktree-unresolved', info.error);
    entry.method = info.method;
    if (info.owner) entry.owner = info.owner;
    return markForRemoval(entry, 'head-on-remote', options);
  }
  const preserved = new Map();
  const unsafe = [];
  for (const sha of [...local].reverse()) {
    const changed = commitPaths(copy, sha);
    if (!changed) {
      return keepUnreadable(entry, 'inspection-failed', `cannot read ${sha.slice(0, 12)}`);
    }
    const ref = preferredRef(bySha.get(sha));
    if (changed.merge) {
      return keep(entry, 'unpublished',
        `ref ${ref} carries local-only merge ${sha.slice(0, 12)}`, true);
    }
    for (const path of changed.paths) {
      if (underPreserved(path)) {
        if (!safeRelativePath(path)) continue;
        const candidate = { sha, path, ref };
        const current = preserved.get(path);
        if (!current) {
          preserved.set(path, candidate);
          continue;
        }
        const winner = preservedWinner(copy, current, candidate);
        if (winner.error) {
          return keepUnreadable(entry, 'inspection-failed', winner.error);
        }
        if (winner.conflict) {
          return keep(entry, 'preserve-conflict',
            describePreserveConflict(winner.conflict), true);
        }
        preserved.set(path, winner.item);
      } else {
        unsafe.push({ ref, sha, path });
      }
    }
  }
  if (unsafe.length) {
    const first = unsafe[0];
    return keep(entry, 'unpublished',
      `ref ${first.ref} carries unpublished product change ` +
      `${first.sha.slice(0, 12)}:${first.path}`, true);
  }
  const classified = classifyPreserved(copy, preserved);
  if (classified.error) return keepUnreadable(entry, 'inspection-failed', classified.error);
  if (classified.unsupported) {
    return keep(entry, 'unpreservable',
      `${classified.unsupported.path} (${classified.unsupported.kind})`, true);
  }
  const files = new Map(classified.files.map((file) => [file.path, file]));
  for (const file of worktreePreserved(special)) {
    const existing = files.get(file.path);
    if (!existing) {
      files.set(file.path, file);
      continue;
    }
    if (existing.kind !== file.kind) {
      return keep(entry, 'preserve-conflict', describePreserveConflict({
        path: file.path, other: file.path, ref: preservedSource(existing),
        otherRef: preservedSource(file), kind: existing.kind, otherKind: file.kind,
      }), true);
    }
  }
  const conflict = preserveConflict([...files.values()]);
  if (conflict) {
    return keep(entry, 'preserve-conflict', describePreserveConflict(conflict), true);
  }
  const info = worktreeInfo(copy, options);
  if (info.error) return keep(entry, info.reason ?? 'worktree-unresolved', info.error);
  entry.method = info.method;
  if (info.owner) entry.owner = info.owner;
  entry.localCommits = local;
  entry.preserveFiles = [...files.values()];
  entry.preservePaths = [...files.keys()].sort();
  return markForRemoval(entry, 'local-only-handoffs', options);
}

/**
 * Repeat the whole decision immediately before removing: the same ref scan (stash, notes and
 * every other local ref included), the same lock, idle, dirty and preserve gates. A stash or note
 * made between the decision and the removal therefore keeps the copy, and a failure to read now
 * keeps it with an error instead of reading as a clean copy. `{ fresh }` means it is still a
 * removal; `{ keep }` carries the reason it is not.
 */
function recheck(entry, options, cache) {
  let fresh;
  try {
    fresh = inspect(entry.path, options, cache);
  } catch (error) {
    return { keep: { reason: 'inspection-failed', detail: `recheck: ${error.message}`,
      error: true, readFailure: true } };
  }
  if (fresh.decision !== 'remove') {
    return { keep: {
      reason: fresh.reason,
      detail: `recheck: ${fresh.detail ?? 'the copy changed'}`,
      lostWork: Boolean(fresh.lostWork),
      error: Boolean(fresh.error),
      readFailure: Boolean(fresh.readFailure),
    } };
  }
  return { fresh };
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
      entry = keepUnreadable(emptyEntry(copy), 'inspection-failed', error.message);
    }
    copies.push(entry);
  }
  const pruned = [];
  const pruneErrors = [];
  if (options.apply) {
    const owners = new Set();
    for (const entry of copies) {
      if (entry.decision !== 'remove') continue;
      const checked = recheck(entry, options, cache);
      if (checked.keep) {
        entry.decision = 'keep';
        entry.reason = checked.keep.reason;
        entry.detail = checked.keep.detail;
        entry.lostWork = checked.keep.lostWork;
        delete entry.preservedTo;
        if (checked.keep.error) entry.error = true;
        else delete entry.error;
        if (checked.keep.readFailure) entry.readFailure = true;
        else delete entry.readFailure;
        continue;
      }
      Object.assign(entry, {
        sha: checked.fresh.sha,
        sizeBytes: checked.fresh.sizeBytes,
        method: checked.fresh.method,
        owner: checked.fresh.owner,
        localCommits: checked.fresh.localCommits,
        preserveFiles: checked.fresh.preserveFiles,
        preservePaths: checked.fresh.preservePaths,
        preserveTo: checked.fresh.preserveTo,
      });
      if (entry.localCommits?.length || entry.preservePaths?.length) {
        const preserved = preserveFiles(entry.path, entry, options);
        if (!preserved.ok) {
          Object.assign(entry, {
            decision: 'keep',
            reason: preserved.unsupported ? 'unpreservable' : 'preserve-failed',
            detail: preserved.error,
            error: !preserved.unsupported,
            lostWork: Boolean(preserved.unsupported),
            preservedTo: undefined,
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
  const readErrors = copies.filter((entry) => entry.readFailure).map((entry) => entry.name);
  const removalErrors = copies.filter((entry) => entry.error && !entry.readFailure)
    .map((entry) => entry.name);
  const failed = readErrors.length > 0 || removalErrors.length > 0 || pruneErrors.length > 0;
  const summary = {
    total: copies.length,
    remove: copies.filter((entry) => entry.decision === 'remove').length,
    keep: kept.length,
    removed: copies.filter((entry) => entry.removed).length,
    keptForLostWork: kept.filter((entry) => entry.lostWork).map((entry) => entry.name),
    readErrors,
    removalErrors,
    pruned,
  };
  if (pruneErrors.length) summary.pruneErrors = pruneErrors;
  const exitCode = failed
    ? EXIT.failure
    : summary.keptForLostWork.length > 0 ? EXIT.lostWork : EXIT.ok;
  return {
    root: options.root,
    apply: options.apply,
    idleMinutes: options.idleMinutes,
    preserve: options.preserve,
    shared: options.shared,
    remote: options.remote,
    copies,
    summary,
    exitCode,
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
  const unreadable = result.summary.readErrors.length;
  const moved = result.apply ? result.summary.removed : result.summary.remove;
  const verb = result.apply ? 'removed' : 'to remove';
  const unread = unreadable ? `, ${unreadable} unreadable` : '';
  console.log(`wish-reap: ${result.summary.total} copies, ${moved} ${verb}, ` +
    `${result.summary.keep} kept, ${lost} kept for lost work${unread}${mode}`);
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
