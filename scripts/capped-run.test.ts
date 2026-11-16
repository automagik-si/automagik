// scripts/capped-run: one command under a memory-capped user scope, or UNCAPPED where a cgroup
// scope is impossible; a memory kill is reported as CAPPED with a 0600 log line, the full-gate
// flock is taken only with --lock, and the child gets neither the live-core variables nor the
// real runtime folder (it gets a fresh scratch one, removed after the run). Every test uses its
// own state folder and (where needed) a stub PATH. The lock rows run a copy of the wrapper in a
// scratch git checkout, so they never lock the real full-gate lock; the outer-lock row only
// probes that real path non-blockingly. No test touches a live terminal or the network.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'capped-run');
const work = mkdtempSync(join(tmpdir(), 'capped-run-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

let sequence = 0;

function scratch(name: string): string {
  const path = join(work, `${name}-${sequence++}`);
  mkdirSync(path, { recursive: true });
  return path;
}

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
  milliseconds: number;
  log: string;
  logPath: string;
  lines: () => string[];
}

interface RunOptions {
  env?: Record<string, string>;
  state?: string;
  path?: string;
  timeout?: number;
  cwd?: string;
}

function cappedRun(args: string[], options: RunOptions = {}): Outcome {
  const state = options.state ?? scratch('state');
  const env: Record<string, string | undefined> = {
    ...process.env,
    CAPPED_RUN_TEST_STATE: state,
    ...options.env,
  };
  if (options.path) env.PATH = options.path;
  const started = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync('sh', [SCRIPT, ...args], {
    cwd: options.cwd ?? work,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 30_000,
  });
  const logPath = join(state, 'runs.log');
  const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    milliseconds: Date.now() - started,
    log,
    logPath,
    lines: () => log.trim().split('\n').filter(Boolean),
  };
}

// A real user scope is needed for the cap itself: cgroup v2, a user manager and systemd-run
// that accepts the scope's memory properties. Everything else runs UNCAPPED by design.
function userScopeWorks(): boolean {
  if (process.platform !== 'linux' || !existsSync('/sys/fs/cgroup/cgroup.controllers')) return false;
  const probe = spawnSync(
    'systemd-run',
    [
      '--user',
      '--scope',
      '--collect',
      '--quiet',
      '-p',
      'MemoryMax=64M',
      '-p',
      'MemorySwapMax=0',
      'true',
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return probe.status === 0;
}

function flockWorks(): boolean {
  return spawnSync('flock', ['--version'], { encoding: 'utf8' }).status === 0;
}

const scope = userScopeWorks();
const flock = flockWorks();

async function waitFor(path: string, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return existsSync(path);
}

async function goneWithin(path: string, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await Bun.sleep(100);
  }
  return !existsSync(path);
}

async function processGoneWithin(pid: number, milliseconds: number): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await Bun.sleep(100);
  }
  return false;
}

function shmHasRoom(): boolean {
  if (!existsSync('/dev/shm')) return false;
  const df = spawnSync('df', ['-k', '/dev/shm'], { encoding: 'utf8' });
  if (df.status !== 0) return false;
  const line = (df.stdout ?? '').trim().split('\n').pop() ?? '';
  const availableKb = Number((line.trim().split(/\s+/) ?? [])[3]);
  return Number.isFinite(availableKb) && availableKb > 1024 * 1024;
}

const dd = spawnSync('dd', ['--version'], { encoding: 'utf8' }).status === 0;

function mainCheckout(): string {
  const git = spawnSync('git', ['-C', join(import.meta.dir, '..'), 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  const first = (git.stdout ?? '')
    .split('\n')
    .find(line => line.startsWith('worktree '));
  return first ? first.slice('worktree '.length).trim() : join(import.meta.dir, '..');
}

function sharedLockWritable(): boolean {
  try {
    mkdirSync(join(mainCheckout(), '.automagik', 'locks'), { recursive: true, mode: 0o700 });
    return true;
  } catch {
    return false;
  }
}

function closeCode(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => child.on('close', code => resolve(code)));
}

interface LockScratch {
  root: string;
  script: string;
  lock: string;
}

let lockScratch: LockScratch | null = null;

function scratchCheckout(): LockScratch {
  if (lockScratch) return lockScratch;
  const root = mkdtempSync(join('/dev/shm', 'capped-run-lockrepo-'));
  const script = join(root, 'scripts', 'capped-run');
  mkdirSync(dirname(script), { recursive: true });
  cpSync(SCRIPT, script);
  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
  if (init.status !== 0) throw new Error('git init failed for the lock scratch checkout');
  lockScratch = { root, script, lock: join(root, '.automagik', 'locks', 'full-gate.lock') };
  return lockScratch;
}

function scratchLockReady(): boolean {
  try {
    scratchCheckout();
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  if (lockScratch) rmSync(lockScratch.root, { recursive: true, force: true });
});

const unshareWorks = (() => {
  if (process.platform !== 'linux') return false;
  const probe = spawnSync(
    'unshare',
    [
      '-rm',
      'sh',
      '-c',
      'mount -t tmpfs tmpfs /tmp && git -C "$1" worktree list --porcelain | head -1',
      'sh',
      import.meta.dir,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return probe.status === 0 && (probe.stdout ?? '').trim().startsWith(`worktree ${mainCheckout()}`);
})();

describe('capped-run', () => {
  test('passes a passing and a failing exit code through unchanged', () => {
    const passing = cappedRun(['--', 'sh', '-c', 'printf pass; exit 0']);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toBe('pass');
    expect(passing.stderr.split('\n').filter(line => line.startsWith('CAPPED: '))).toHaveLength(0);

    const failing = cappedRun(['--', 'sh', '-c', 'exit 3']);
    expect(failing.status).toBe(3);
    expect(failing.stderr.split('\n').filter(line => line.startsWith('CAPPED: '))).toHaveLength(0);
  });

  test('a failing systemd-run falls back to UNCAPPED, one line, and the child exit code', () => {
    const bin = scratch('stub-bin');
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(bin, 'systemd-run'), 0o755);
    const path = `${bin}:${process.env.PATH ?? ''}`;

    const outcome = cappedRun(['--', 'sh', '-c', 'printf child-output; exit 7'], { path });
    expect(outcome.status).toBe(7);
    expect(outcome.stdout).toBe('child-output');
    const uncapped = outcome.stderr.split('\n').filter(line => line.startsWith('UNCAPPED: '));
    expect(uncapped).toHaveLength(1);
    expect(uncapped[0]).toMatch(/^UNCAPPED: \S/);
    expect(outcome.stderr.split('\n').filter(line => line.startsWith('CAPPED: '))).toHaveLength(0);
  });

  test('refuses a cap above 8G with one line and starts nothing', () => {
    const outcome = cappedRun(['--mem', '9G', '--', 'true']);
    expect(outcome.status).toBe(2);
    expect(outcome.stderr.trim().split('\n')).toHaveLength(1);
    expect(outcome.stderr).toContain('8');
    expect(outcome.stderr).toContain('ceiling');
    expect(outcome.stderr).not.toContain('UNCAPPED:');
  });

  test('the child gets no live-core variables, no session and no real runtime folder', () => {
    const parentRuntime = process.env.XDG_RUNTIME_DIR ?? '';
    const child = [
      'printf "vars:%s|%s|%s|%s|%s\\n" "${HC_SCOPE-}" "${HC_SOCKET-}" "${HC_TERMINAL_SOCKET-}" "${HC_TERMINAL_ID-}" "${HC_SESSION-}"',
      'printf "rt:%s\\n" "${XDG_RUNTIME_DIR-}"',
      'if [ -n "${XDG_RUNTIME_DIR-}" ]; then ls -ld "$XDG_RUNTIME_DIR" | cut -c1-10; fi',
    ].join('; ');
    const outcome = cappedRun(['--', 'sh', '-c', child], {
      env: {
        HC_SCOPE: 'scope-from-pane',
        HC_SOCKET: '/tmp/socket-from-pane',
        HC_TERMINAL_SOCKET: '/tmp/terminal-socket-from-pane',
        HC_TERMINAL_ID: 'pane-name',
        HC_SESSION: 'live-session',
      },
    });
    expect(outcome.status).toBe(0);
    const lines = outcome.stdout.trim().split('\n');
    expect(lines[0]).toBe('vars:||||');
    const runtime = lines[1].slice('rt:'.length);
    expect(runtime).not.toBe('');
    expect(runtime).not.toBe(parentRuntime);
    expect(lines[2]).toBe('drwx------');
    // The scratch folder is per run and goes away with the run.
    expect(existsSync(runtime)).toBe(false);
  });

  test('the child gets a TMPDIR outside any git work tree, from inside the repo', () => {
    const repoRoot = join(import.meta.dir, '..');
    const parentTmpdir = mkdtempSync(join(repoRoot, 'tmpdir-in-repo-'));
    const child = [
      'printf "tmpdir:%s\\n" "${TMPDIR-}"',
      'if [ -n "${TMPDIR-}" ]; then ls -ld "$TMPDIR" | cut -c1-10; else echo missing; fi',
      'if [ -n "${TMPDIR-}" ]; then git -C "$TMPDIR" rev-parse --show-toplevel >/dev/null 2>&1; echo "git:$?"; else echo git:127; fi',
    ].join('; ');
    try {
      // The run starts inside the repo and the parent's TMPDIR is inside it too: the wrapper must
      // still hand the child a fresh TMPDIR that is not inside a work tree, and remove it.
      const outcome = cappedRun(['--', 'sh', '-c', child], {
        cwd: repoRoot,
        env: { TMPDIR: parentTmpdir },
      });
      expect(outcome.status).toBe(0);
      const lines = outcome.stdout.trim().split('\n');
      const tmpdir = lines[0].slice('tmpdir:'.length);
      expect(tmpdir).not.toBe('');
      expect(tmpdir).not.toBe(parentTmpdir);
      expect(lines[1]).toBe('drwx------');
      expect(lines[2]).not.toBe('git:0');
      expect(existsSync(tmpdir)).toBe(false);
    } finally {
      rmSync(parentTmpdir, { recursive: true, force: true });
    }
  });

  // Mutant 14: the wrapper must not set MemoryHigh (a high at 75% would throttle the cap-kill
  // test instead of letting it reach MemoryMax). An unset MemoryHigh leaves memory.high at max.
  test.skipIf(!scope)('the scope has no MemoryHigh: memory.high stays max', () => {
    const readHigh = 'cg=$(sed -n "s/^0:://p" /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.high"';
    const outcome = cappedRun(['--', 'sh', '-c', readHigh]);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout.trim()).toBe('max');
  });

  // One rule with mutant 4: --mem only raises. 256M is below the 4G default and must leave the
  // cap at 4294967296 bytes (4G); 6G is above it and must raise the cap to 6442450944 bytes.
  test.skipIf(!scope)('only raises the cap: --mem 256M below the 4G default stays 4G, and 6G raises it', () => {
    const readMax = 'cg=$(sed -n "s/^0:://p" /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max"';

    const lowered = cappedRun(['--mem', '256M', '--', 'sh', '-c', readMax]);
    expect(lowered.status).toBe(0);
    expect(Number(lowered.stdout.trim())).toBe(4 * 1024 * 1024 * 1024);

    const raised = cappedRun(['--mem', '6G', '--', 'sh', '-c', readMax]);
    expect(raised.status).toBe(0);
    expect(Number(raised.stdout.trim())).toBe(6 * 1024 * 1024 * 1024);
  });

  test.skipIf(!flock)('--lock waits for the full-gate lock, runs, and logs start and end', async () => {
    const state = scratch('lock-state');
    const lock = join(work, 'held.lock');
    const ready = join(work, 'held.ready');
    const holder = spawn('flock', ['-x', lock, 'sh', '-c', ': >"$1"; sleep 1', 'sh', ready], {
      stdio: 'ignore',
    });
    expect(await waitFor(ready, 5_000)).toBe(true);

    const outcome = cappedRun(['--lock', '--', 'sh', '-c', 'exit 0', 'argv-leak-marker'], {
      state,
      env: { CAPPED_RUN_LOCK_FILE: lock, HC_TERMINAL_ID: 'pane-name', LEAK_ENV_MARKER: 'env-leak-marker' },
      timeout: 30_000,
    });
    holder.kill();

    expect(outcome.status).toBe(0);
    expect(outcome.milliseconds).toBeGreaterThan(400);
    // The first output line under --lock proves the resolved path and the file it locked.
    const lockLine = outcome.stderr.split('\n')[0];
    expect(lockLine).toContain(`path=${lock} dev=`);
    expect(lockLine).toMatch(/ dev=\S+ ino=\S+$/);
    const lines = outcome.lines();
    expect(lines.filter(line => / start owner=\S+ comm=sh$/.test(line))).toHaveLength(1);
    expect(lines.filter(line => / end owner=\S+ comm=sh exit=0$/.test(line))).toHaveLength(1);
    expect(outcome.log).not.toContain('argv-leak-marker');
    expect(outcome.log).not.toContain('env-leak-marker');
    expect(statSync(outcome.logPath).mode & 0o777).toBe(0o600);
    // The lock file stays 0600 and its folder 0700.
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(statSync(work).mode & 0o777).toBe(0o700);
  });

  test.skipIf(!flock)('the start line is in the log before the command runs', async () => {
    const state = scratch('order-state');
    const logPath = join(state, 'runs.log');
    const lock = join(work, 'order.lock');
    // The child exits 0 only after it has seen the start line in the log: a wrapper that wrote
    // that line after the run (or at exit) leaves the child looping until it exits 5.
    const child =
      `i=0; while [ "$i" -lt 100 ]; do grep -q " start owner=" "${logPath}" && exit 0; ` +
      'sleep 0.05; i=$((i+1)); done; exit 5';
    const outcome = cappedRun(['--lock', '--', 'sh', '-c', child], {
      state,
      env: { CAPPED_RUN_LOCK_FILE: lock },
      timeout: 30_000,
    });
    expect(outcome.status).toBe(0);
    expect(outcome.lines().filter(line => line.includes(' start owner='))).toHaveLength(1);
  });

  test.skipIf(!flock)('without --lock a run does not take the full-gate lock', async () => {
    const state = scratch('nolock-state');
    const lock = join(work, 'unused.lock');
    const ready = join(work, 'unused.ready');
    const holder = spawn('flock', ['-x', lock, 'sh', '-c', ': >"$1"; sleep 2', 'sh', ready], {
      stdio: 'ignore',
    });
    expect(await waitFor(ready, 5_000)).toBe(true);

    const outcome = cappedRun(['--', 'sh', '-c', 'exit 0'], {
      state,
      env: { CAPPED_RUN_LOCK_FILE: lock },
      timeout: 30_000,
    });
    holder.kill();

    expect(outcome.status).toBe(0);
    expect(outcome.milliseconds).toBeLessThan(1_500);
    expect(outcome.log).toBe('');
  });

  test.skipIf(!scope)(
    'a memory kill exits 137, prints one CAPPED line with a labelled peak floor of at least 90 percent of the cap, and logs it before exiting',
    () => {
      const state = scratch('cap-state');
      const lock = join(work, 'cap.lock');
      const allocator = join(scratch('allocator'), 'argv-leak-marker-alloc.js');
      writeFileSync(allocator, 'const hold = [];\nfor (;;) hold.push(Buffer.alloc(1 << 20, 1));\n');

      const outcome = cappedRun(['--mem', '256M', '--lock', '--', process.execPath, allocator], {
        state,
        env: {
          CAPPED_RUN_LOCK_FILE: lock,
          CAPPED_RUN_TEST_MEM: '256M',
          HC_TERMINAL_ID: 'pane-name',
          LEAK_ENV_MARKER: 'env-leak-marker',
        },
        timeout: 120_000,
      });

      const command = basename(process.execPath);
      expect(outcome.status).toBe(137);
      const capped = outcome.stderr.split('\n').filter(line => line.startsWith('CAPPED: '));
      expect(capped).toHaveLength(1);
      expect(capped[0]).toContain('CAPPED: a process in the run was killed at the memory limit (limit=256M, peak>=');
      // Labelled peak bound: the floor is at least 90 percent of the cap, the measured last
      // sample is named, and a bare peak=<limit> (mutants 15 and 18) fails here.
      const floorMib = Number((capped[0].match(/peak>=([0-9.]+)M/) ?? [])[1]);
      expect(Number.isFinite(floorMib)).toBe(true);
      expect(floorMib * 1024 * 1024).toBeGreaterThanOrEqual(0.9 * 256 * 1024 * 1024);
      expect(capped[0]).toMatch(/last sample (?:[0-9.]+M|unknown)/);
      expect(capped[0]).not.toMatch(/peak=[0-9.]+M/);
      expect(capped[0]).toContain(`command=${command})`);
      // No stray "Killed" or other line on stderr: the LOCK line, then the one CAPPED line.
      expect(outcome.stderr.trim().split('\n').filter(line => !line.startsWith('LOCK: '))).toEqual([capped[0]]);
      expect(outcome.stderr).not.toContain('argv-leak-marker');
      expect(outcome.stderr).not.toContain('env-leak-marker');

      // The CAPPED append sits between the start line and the end line. A mutant that moved it
      // after the script's exit cannot write it at all (a shell runs nothing after exit), which
      // the assertions above already catch; an EXIT-trap write still happens before the process
      // ends, which is exactly what the brief asks for and cannot be told apart from the outside.
      const lines = outcome.lines();
      expect(lines.filter(line => line.startsWith('CAPPED: '))).toHaveLength(1);
      // The log line is the same text as the one on stderr.
      expect(lines.find(line => line.startsWith('CAPPED: '))).toBe(capped[0]);
      expect(lines.findIndex(line => line.startsWith('CAPPED: '))).toBeLessThan(
        lines.findIndex(line => line.includes(' end owner=')),
      );
      expect(
        lines.filter(line => line.includes(' start owner=') && line.endsWith(`comm=${command}`)),
      ).toHaveLength(1);
      expect(
        lines.filter(
          line => line.includes(' end owner=') && line.endsWith(`comm=${command} exit=137`),
        ),
      ).toHaveLength(1);
      expect(outcome.log).not.toContain('argv-leak-marker');
      expect(outcome.log).not.toContain('env-leak-marker');
      expect(statSync(outcome.logPath).mode & 0o777).toBe(0o600);
    },
    120_000,
  );

  test.skipIf(!scope || !dd || !shmHasRoom())(
    'a dd-like allocation killed at the cap reports a labelled peak floor of at least 90 percent of the cap',
    () => {
      const state = scratch('dd-state');
      const file = join('/dev/shm', `capped-run-dd-${process.pid}-${Date.now()}`);
      try {
        const outcome = cappedRun(
          ['--mem', '256M', '--', 'dd', 'if=/dev/zero', `of=${file}`, 'bs=1M', 'count=512', 'status=none'],
          { state, env: { CAPPED_RUN_TEST_MEM: '256M' }, timeout: 120_000 },
        );
        expect(outcome.status).toBe(137);
        const capped = outcome.stderr.split('\n').filter(line => line.startsWith('CAPPED: '));
        expect(capped).toHaveLength(1);
        expect(capped[0]).toContain('CAPPED: a process in the run was killed at the memory limit (limit=256M, peak>=');
        const floorMib = Number((capped[0].match(/peak>=([0-9.]+)M/) ?? [])[1]);
        expect(Number.isFinite(floorMib)).toBe(true);
        expect(floorMib * 1024 * 1024).toBeGreaterThanOrEqual(0.9 * 256 * 1024 * 1024);
        expect(capped[0]).toMatch(/last sample (?:[0-9.]+M|unknown)/);
        expect(capped[0]).not.toMatch(/peak=[0-9.]+M/);
        // The one line is all stderr says: no shell "Killed" leak.
        expect(outcome.stderr.trim()).toBe(capped[0]);
      } finally {
        rmSync(file, { force: true });
      }
    },
    120_000,
  );

  test.skipIf(!scope)('a very short run (under 100 ms) leaves no peak file in the state folder', () => {
    const state = scratch('short-state');
    const outcome = cappedRun(['--', 'sh', '-c', 'exit 0'], { state });
    expect(outcome.status).toBe(0);
    expect(readdirSync(state).filter(name => name.startsWith('peak'))).toEqual([]);
  });

  test.skipIf(!scope)(
    'a wrapper killed from outside stops its scope and removes its scratch folders and peak file',
    async () => {
      const state = scratch('signal-state');
      const info = join(work, 'signal-info.txt');
      const childScript =
        'printf "%s\\n%s\\n%s\\n" "$$" "${TMPDIR-}" "${XDG_RUNTIME_DIR-}" > "$0.tmp" && mv "$0.tmp" "$0"; sleep 30';
      const wrapper = spawn('sh', [SCRIPT, '--', 'sh', '-c', childScript, info], {
        cwd: work,
        env: { ...process.env, CAPPED_RUN_TEST_STATE: state },
        stdio: 'ignore',
      });
      let pid = 0;
      try {
        expect(await waitFor(info, 20_000)).toBe(true);
        const [pidText, tmpdir, runtime] = readFileSync(info, 'utf8').trim().split('\n');
        pid = Number(pidText);
        wrapper.kill('SIGTERM');
        const ended = await new Promise<{ code: number | null; signal: string | null }>(resolve => {
          const timer = setTimeout(() => resolve({ code: null, signal: null }), 20_000);
          wrapper.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        });
        expect(ended.code !== null || ended.signal !== null).toBe(true);
        expect(await goneWithin(tmpdir, 10_000)).toBe(true);
        expect(await goneWithin(runtime, 10_000)).toBe(true);
        expect(await processGoneWithin(pid, 10_000)).toBe(true);
        expect(readdirSync(state).filter(name => name.startsWith('peak'))).toEqual([]);
      } finally {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
        wrapper.kill('SIGKILL');
      }
    },
    90_000,
  );

  test.skipIf(!scope)('a 137 that is not a memory kill passes through with no CAPPED line', () => {
    const state = scratch('selfkill-state');
    const lock = join(work, 'selfkill.lock');
    const outcome = cappedRun(['--lock', '--', 'sh', '-c', 'kill -9 $$'], {
      state,
      env: { CAPPED_RUN_LOCK_FILE: lock },
    });
    expect(outcome.status).toBe(137);
    expect(outcome.stderr.trim().split('\n').filter(line => !line.startsWith('LOCK: '))).toEqual([]);
    const lines = outcome.lines();
    expect(lines.filter(line => line.startsWith('CAPPED: '))).toHaveLength(0);
    expect(lines.filter(line => / end owner=\S+ comm=sh exit=137$/.test(line))).toHaveLength(1);
  });

  test.skipIf(!scope)('a 137 with an unreadable cause prints one line and no CAPPED', () => {
    const state = scratch('unknown-state');
    const outcome = cappedRun(['--', 'sh', '-c', 'kill -9 $$'], {
      state,
      env: { CAPPED_RUN_TEST_UNREADABLE_EVENTS: '1' },
    });
    expect(outcome.status).toBe(137);
    const lines = outcome.stderr.trim().split('\n').filter(Boolean);
    expect(lines.filter(line => line.startsWith('CAPPED: '))).toHaveLength(0);
    expect(lines).toEqual(['exit 137: could not read the memory-kill cause (scope gone, command=sh)']);
  });

  test.skipIf(process.platform !== 'linux' || !flock || !scratchLockReady())(
    'two concurrent runs exclude each other on a scratch checkout lock (Linux; no real lock)',
    async () => {
      const { root, script, lock } = scratchCheckout();
      const seq = join('/dev/shm', `capped-run-lock-seq-${process.pid}-${Date.now()}`);
      const child = join('/dev/shm', `capped-run-lock-child-${process.pid}-${Date.now()}.sh`);
      writeFileSync(child, 'printf "start\\n" >> "$1"\nsleep 0.5\nprintf "end\\n" >> "$1"\n');
      const env = { ...process.env, CAPPED_RUN_TEST_LOCK_WAIT: '60' };
      let firstErr = '';
      try {
        const first = spawn('sh', [script, '--lock', '--', 'sh', child, seq], {
          cwd: root,
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        first.stderr?.on('data', chunk => {
          firstErr += chunk.toString();
        });
        const firstDone = closeCode(first);
        expect(await waitFor(seq, 20_000)).toBe(true);
        const second = spawn('sh', [script, '--lock', '--', 'sh', child, seq], {
          cwd: root,
          env,
          stdio: 'ignore',
        });
        const secondDone = closeCode(second);
        expect(await Promise.all([firstDone, secondDone])).toEqual([0, 0]);
        expect(readFileSync(seq, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
        // The scratch checkout's own lock was used, with its modes, never the real one.
        expect(firstErr.split('\n')[0]).toContain(`path=${lock} dev=`);
        expect(firstErr.split('\n')[0]).toMatch(/ dev=\S+ ino=\S+$/);
        expect(statSync(lock).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(lock)).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(seq, { force: true });
        rmSync(child, { force: true });
      }
    },
    60_000,
  );

  test.skipIf(process.platform !== 'linux' || !flock || !scratchLockReady() || !unshareWorks)(
    'a run with its own tmpfs on /tmp still excludes on a scratch checkout lock (Linux; unshare -rm)',
    async () => {
      const { root, script, lock } = scratchCheckout();
      const seq = join('/dev/shm', `capped-run-unshare-seq-${process.pid}-${Date.now()}`);
      const child = join('/dev/shm', `capped-run-unshare-child-${process.pid}-${Date.now()}.sh`);
      writeFileSync(child, 'printf "start\\n" >> "$1"\nsleep 0.5\nprintf "end\\n" >> "$1"\n');
      const env = { ...process.env, CAPPED_RUN_TEST_LOCK_WAIT: '60' };
      const inner = 'mount -t tmpfs tmpfs /tmp && exec sh "$1" --lock -- sh "$2" "$3"';
      let firstErr = '';
      try {
        const first = spawn('sh', [script, '--lock', '--', 'sh', child, seq], {
          cwd: root,
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        first.stderr?.on('data', chunk => {
          firstErr += chunk.toString();
        });
        const firstDone = closeCode(first);
        expect(await waitFor(seq, 20_000)).toBe(true);
        // The second run mounts its own tmpfs on /tmp: the scratch checkout's lock must still be
        // the same file, or the two runs overlap (mutant 20 fails here).
        const second = spawn('unshare', ['-rm', 'sh', '-c', inner, 'sh', script, child, seq], {
          cwd: root,
          env,
          stdio: 'ignore',
        });
        const secondDone = closeCode(second);
        expect(await Promise.all([firstDone, secondDone])).toEqual([0, 0]);
        expect(readFileSync(seq, 'utf8').trim().split('\n')).toEqual(['start', 'end', 'start', 'end']);
        expect(firstErr.split('\n')[0]).toContain(`path=${lock} dev=`);
      } finally {
        rmSync(seq, { force: true });
        rmSync(child, { force: true });
      }
    },
    60_000,
  );

  test.skipIf(process.platform !== 'linux' || !flock || !sharedLockWritable() || !scratchLockReady())(
    "the file's own lock rows do not wait on the outer full-gate lock",
    async () => {
      const { root, script, lock } = scratchCheckout();
      const realLock = join(mainCheckout(), '.automagik', 'locks', 'full-gate.lock');
      // Hold the real lock if we can; when the outer run already holds it the non-blocking probe
      // just fails, and the real lock is held anyway. Either way the scratch run must not wait.
      const holder = spawn('flock', ['-n', '-x', realLock, 'sh', '-c', 'sleep 5'], {
        stdio: 'ignore',
      });
      await Bun.sleep(300);
      try {
        const started = Date.now();
        const outcome = spawnSync('sh', [script, '--lock', '--', 'sh', '-c', 'exit 0'], {
          cwd: root,
          env: { ...process.env, CAPPED_RUN_TEST_LOCK_WAIT: '10' },
          encoding: 'utf8',
          timeout: 15_000,
        });
        expect(outcome.status).toBe(0);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect((outcome.stderr ?? '').split('\n')[0]).toContain(`path=${lock} dev=`);
      } finally {
        holder.kill();
      }
    },
    30_000,
  );

  test.skipIf(!scope || !dd || !shmHasRoom())(
    'a grandchild OOM kill prints one CAPPED line and the child exit 1 passes through',
    () => {
      const state = scratch('grandchild-state');
      const file = join('/dev/shm', `capped-run-grandchild-${process.pid}-${Date.now()}`);
      const script = `dd if=/dev/zero of=${file} bs=1M count=512 status=none & wait; exit 1`;
      try {
        const outcome = cappedRun(['--mem', '256M', '--', 'sh', '-c', script], {
          state,
          env: { CAPPED_RUN_TEST_MEM: '256M' },
          timeout: 120_000,
        });
        expect(outcome.status).toBe(1);
        const capped = outcome.stderr.split('\n').filter(line => line.startsWith('CAPPED: '));
        expect(capped).toHaveLength(1);
        expect(capped[0]).toContain('CAPPED: a process in the run was killed at the memory limit (limit=256M, peak>=');
        const floorMib = Number((capped[0].match(/peak>=([0-9.]+)M/) ?? [])[1]);
        expect(Number.isFinite(floorMib)).toBe(true);
        expect(floorMib * 1024 * 1024).toBeGreaterThanOrEqual(0.9 * 256 * 1024 * 1024);
        expect(capped[0]).toMatch(/last sample (?:[0-9.]+M|unknown)/);
        expect(capped[0]).toContain('command=sh)');
        expect(outcome.log.trim().split('\n')).toContain(capped[0]);
      } finally {
        rmSync(file, { force: true });
      }
    },
    120_000,
  );
});
