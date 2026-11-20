import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The guard around `node --test` (#422). Nothing here depends on timing: a simulated run writes the
// ledger a truncated run would leave, and a real one quits with process.exit(0) at a fixed test.
const GUARD = join(import.meta.dir, 'test-guard.mjs');
const APPS = join(import.meta.dir, '..', 'apps');
const work = mkdtempSync(join(tmpdir(), 'test-guard-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const SIM = join(work, 'sim.mjs');
writeFileSync(SIM, `import { writeFileSync } from 'node:fs';
const destination = process.execArgv.filter((arg) => arg.startsWith('--test-reporter-destination=')).at(-1);
writeFileSync(destination.slice(destination.indexOf('=') + 1), process.env.SIM_TAP);
console.log('the run streamed this');
process.exit(Number(process.env.SIM_EXIT ?? 0));
`);

const guard = (args: string[], cwd = work, env: Record<string, string> = {}) =>
  spawnSync('node', [GUARD, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const simulate = (tap: string, exit = 0) => guard([SIM], work, { SIM_TAP: tap, SIM_EXIT: String(exit) });

const RESULTS = '# test-guard file test/a.test.js\nok 1 - one\nok 2 - two\n';
const SUMMARY = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
const FILES = (done: boolean, saw = 2) =>
  `# test-guard files ${JSON.stringify([{ name: 'test/a.test.js', expected: 3, saw, done }])}\n`;

describe('a simulated run', () => {
  test('a complete one exits 0 and streams the run', () => {
    const run = simulate(`TAP version 13\n${RESULTS}1..2\n${SUMMARY}${FILES(true)}`);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('the run streamed this');
    expect(run.stderr).toContain('test-guard: complete run: plan 1..2, 2 top-level results, 2 tests (2 pass, 0 fail');
    expect(run.stderr).not.toContain('truncated');
  });

  test('a missing plan fails and names the results and the file', () => {
    const run = simulate(`TAP version 13\n${RESULTS}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected a TAP plan, saw 2 results and no plan, file test/a.test.js');
  });

  test('a short plan fails with both counts and the file', () => {
    const run = simulate(`TAP version 13\n${RESULTS}1..1\n${SUMMARY}${FILES(true)}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected 1, saw 2, file test/a.test.js');
  });

  test('a plan of N with fewer results fails with both counts and the file', () => {
    const run = simulate(`TAP version 13\n${RESULTS}1..196\n${SUMMARY}${FILES(true)}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected 196, saw 2, file test/a.test.js');
  });

  test('a matching plan with a file short of its summary fails: the plan alone cannot see this', () => {
    const run = simulate(`TAP version 13\n${RESULTS}1..2\n${SUMMARY}${FILES(false)}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected 3, saw 2, file test/a.test.js: no end-of-file summary');
  });

  test('a matching plan with no per-file record fails closed', () => {
    const run = simulate(`TAP version 13\n${RESULTS}1..2\n${SUMMARY}`);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected the per-file record after the plan, saw none');
  });

  test('no ledger at all fails', () => {
    const run = guard(['-e', 'process.exit(0)']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected a TAP plan, saw 0 results and no plan');
  });

  test('a run that failed keeps its exit code, truncated or not', () => {
    const complete = simulate(`TAP version 13\n${RESULTS}1..2\n${SUMMARY}${FILES(true)}`, 7);
    expect(complete.status).toBe(7);
    expect(complete.stderr).not.toContain('truncated');
    const cut = simulate(`TAP version 13\n${RESULTS}`, 7);
    expect(cut.status).toBe(7);
    expect(cut.stderr).toContain('test-guard: truncated run:');
  });
});

describe('a real node --test run', () => {
  const project = (name: string, files: Record<string, string>) => {
    const dir = join(work, name);
    mkdirSync(join(dir, 'test'), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, 'test', file), text);
    return dir;
  };
  const RUN = ['--test', '--test-force-exit', 'test/*.test.js'];
  const NAMED = (...names: string[]) => `import test from 'node:test';\n${names.map((name) => `test('${name}', () => {});\n`).join('')}`;

  test('a complete one exits 0, and a test printing TAP does not pass for the plan', () => {
    const dir = project('complete', {
      'a.test.js': `import test from 'node:test';\ntest('prints', () => { console.log('ok 9 - printed'); console.log('1..99'); });\n`,
      'b.test.js': NAMED('b one', 'b two'),
    });
    const run = guard(RUN, dir);
    expect(run.status).toBe(0);
    expect(run.stderr).toContain('test-guard: complete run: plan 1..3, 3 top-level results, 3 tests (3 pass, 0 fail');
    expect(run.stderr).toContain(', 2 files');
    expect(run.stdout).toContain('b two');
  }, 30_000);

  test('a failing test keeps exit 1 and its diagnostics, and is no truncation', () => {
    const dir = project('failing', { 'a.test.js': `import test from 'node:test';\ntest('breaks', () => { throw new Error('the real failure'); });\n` });
    const run = guard(RUN, dir);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('the real failure');
    expect(run.stderr).not.toContain('truncated');
  }, 30_000);

  test('a file that quits at a fixed test: plain node stays green, the guard names it', () => {
    const dir = project('quits', {
      'a.test.js': NAMED('a one'),
      'quits.test.js': `import test from 'node:test';\ntest('first', () => {});\ntest('quits', () => { process.exit(0); });\ntest('never runs', () => {});\n`,
    });
    const plain = spawnSync('node', RUN, { cwd: dir, encoding: 'utf8' });
    expect(plain.status).toBe(0);
    const run = guard(RUN, dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/test-guard: truncated run: expected \d+, saw \d+, file test\/quits\.test\.js: no end-of-file summary/);
    expect(run.stderr).not.toContain('a.test.js');
  }, 30_000);

  test('a file with no tests counts as truncated: it cannot be told from one that quit at once', () => {
    const dir = project('empty', { 'a.test.js': NAMED('a one'), 'empty.test.js': '// nothing here\n' });
    const run = guard(RUN, dir);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('test-guard: truncated run: expected 0, saw 0, file test/empty.test.js: no end-of-file summary');
  }, 30_000);
});

describe('the packages', () => {
  test('every script with --test-force-exit goes through the guard', () => {
    const read = new Map<string, string[]>();
    for (const entry of readdirSync(APPS, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      try {
        const { scripts = {} } = JSON.parse(readFileSync(join(APPS, entry.name, 'package.json'), 'utf8'));
        read.set(entry.name, Object.values<string>(scripts));
      } catch {
        // a folder with no package.json holds no scripts
      }
    }
    // The scan read the packages: each plugin's own test script is among what it read, so an
    // empty result below cannot come from reading nothing.
    for (const plugin of ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'vault-dsh', 'welcome-dsh']) {
      expect(read.get(plugin)?.some((script) => script.includes('--test'))).toBe(true);
    }
    const scripts = [...read.values()].flat().filter((script) => script.includes('--test-force-exit'));
    // None today: the Unfold plugins that ran through the guard left (RFC 0020). The guard and this
    // rule stay for the next package that needs --test-force-exit (#422).
    expect(scripts.filter((script) => !script.startsWith('node ../../scripts/test-guard.mjs '))).toEqual([]);
  });
});
