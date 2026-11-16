// scripts/capped-run: one command under a memory-capped user scope, or UNCAPPED where a cgroup
// scope is impossible; a memory kill is reported as CAPPED with a 0600 log line, the full-gate
// flock is taken only with --lock, and the child never sees the live-core variables. Every test
// uses its own state folder, lock file and (where needed) a stub PATH: no test touches the real
// lock, a live terminal or the network.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
    cwd: work,
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
      'MemoryHigh=48M',
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

describe('capped-run', () => {
  test('passes a passing and a failing exit code through unchanged', () => {
    const passing = cappedRun(['--', 'sh', '-c', 'printf pass; exit 0']);
    expect(passing.status).toBe(0);
    expect(passing.stdout).toBe('pass');
    expect(passing.stderr).not.toContain('CAPPED:');

    const failing = cappedRun(['--', 'sh', '-c', 'exit 3']);
    expect(failing.status).toBe(3);
    expect(failing.stderr).not.toContain('CAPPED:');
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
    expect(outcome.stderr).not.toContain('CAPPED:');
  });

  test('refuses a cap above 8G with one line and starts nothing', () => {
    const outcome = cappedRun(['--mem', '9G', '--', 'true']);
    expect(outcome.status).toBe(2);
    expect(outcome.stderr.trim().split('\n')).toHaveLength(1);
    expect(outcome.stderr).toContain('8');
    expect(outcome.stderr).toContain('ceiling');
    expect(outcome.stderr).not.toContain('UNCAPPED:');
  });

  test('the child never sees the live-core variables, even when the parent has them', () => {
    const child =
      'printf "ok:%s:%s:%s:%s\\n" "${HC_SCOPE-}" "${HC_SOCKET-}" "${HC_TERMINAL_SOCKET-}" "${HC_TERMINAL_ID-}"';
    const outcome = cappedRun(['--', 'sh', '-c', child], {
      env: {
        HC_SCOPE: 'scope-from-pane',
        HC_SOCKET: '/tmp/socket-from-pane',
        HC_TERMINAL_SOCKET: '/tmp/terminal-socket-from-pane',
        HC_TERMINAL_ID: 'pane-name',
      },
    });
    expect(outcome.status).toBe(0);
    expect(outcome.stdout.trim()).toBe('ok::::');
  });

  test.skipIf(!scope)('only raises the cap: a smaller --mem keeps the default, a larger one raises it', () => {
    const readMax = 'cg=$(sed -n "s/^0:://p" /proc/self/cgroup); cat "/sys/fs/cgroup$cg/memory.max"';
    const env = { CAPPED_RUN_TEST_MEM: '1G' };

    const lowered = cappedRun(['--mem', '256M', '--', 'sh', '-c', readMax], { env });
    expect(lowered.status).toBe(0);
    expect(Number(lowered.stdout.trim())).toBe(1024 * 1024 * 1024);

    const raised = cappedRun(['--mem', '2G', '--', 'sh', '-c', readMax], { env });
    expect(raised.status).toBe(0);
    expect(Number(raised.stdout.trim())).toBe(2 * 1024 * 1024 * 1024);
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
      env: { CAPPED_RUN_TEST_LOCK: lock, HC_TERMINAL_ID: 'pane-name', LEAK_ENV_MARKER: 'env-leak-marker' },
      timeout: 30_000,
    });
    holder.kill();

    expect(outcome.status).toBe(0);
    expect(outcome.milliseconds).toBeGreaterThan(400);
    const lines = outcome.lines();
    expect(lines.filter(line => / start owner=\S+ comm=sh$/.test(line))).toHaveLength(1);
    expect(lines.filter(line => / end owner=\S+ comm=sh exit=0$/.test(line))).toHaveLength(1);
    expect(outcome.log).not.toContain('argv-leak-marker');
    expect(outcome.log).not.toContain('env-leak-marker');
    expect(statSync(outcome.logPath).mode & 0o777).toBe(0o600);
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
      env: { CAPPED_RUN_TEST_LOCK: lock },
      timeout: 30_000,
    });
    holder.kill();

    expect(outcome.status).toBe(0);
    expect(outcome.milliseconds).toBeLessThan(1_500);
    expect(outcome.log).toBe('');
  });

  test.skipIf(!scope)(
    'a memory kill exits 137, prints one CAPPED line, and logs it before exiting',
    () => {
      const state = scratch('cap-state');
      const lock = join(work, 'cap.lock');
      const allocator = join(scratch('allocator'), 'argv-leak-marker-alloc.js');
      writeFileSync(allocator, 'const hold = [];\nfor (;;) hold.push(Buffer.alloc(1 << 20, 1));\n');

      const outcome = cappedRun(['--mem', '256M', '--lock', '--', process.execPath, allocator], {
        state,
        env: {
          CAPPED_RUN_TEST_LOCK: lock,
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
      expect(capped[0]).toContain('CAPPED: killed at the memory limit (limit=256M, peak=');
      expect(capped[0]).toMatch(/peak=[^,)]+/);
      expect(capped[0]).toContain(`command=${command})`);
      expect(outcome.stderr).not.toContain('argv-leak-marker');
      expect(outcome.stderr).not.toContain('env-leak-marker');

      const lines = outcome.lines();
      expect(lines.filter(line => line.startsWith('CAPPED: '))).toHaveLength(1);
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
});
