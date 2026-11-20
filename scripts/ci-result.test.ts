// Run the workflow's actual scripts so the required check cannot silently accept a missing job
// or let a skipped check through without an explicit unchanged-area output from `changes`.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const ci = Bun.YAML.parse(
  readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'),
) as any;
const aggregate = ci.jobs['ci-result'];
const step = aggregate.steps.find((step: any) => step.name === 'Every job passed');
const paths = ci.jobs.changes.steps.find((step: any) => step.id === 'paths');
const JOBS = Object.keys(ci.jobs).filter((id) => id !== 'ci-result');
const AREAS = Object.keys(ci.jobs.changes.outputs);
const GATED = Object.fromEntries(Object.entries<any>(ci.jobs).flatMap(([id, job]) => {
  const area = job.if?.match(/needs\.changes\.outputs\.(\w+)/)?.[1];
  return area ? [[id, area]] : [];
}));

type Needs = Record<string, { result: string; outputs?: Record<string, string | boolean> }>;

function areaOutputs(value: string) {
  return Object.fromEntries(AREAS.map((area) => [area, value]));
}

function runResult(event: string, needs: Needs | string) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-result-'));
  try {
    const summary = join(dir, 'summary');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-c', step.run], {
      cwd: REPO,
      encoding: 'utf8',
      env: {
        ...process.env,
        EVENT: event,
        RESULTS: typeof needs === 'string' ? needs : JSON.stringify(needs),
        RUNNER_TEMP: dir,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    return { ...result, summary: readFileSync(summary, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the CI workflow', () => {
  test('requests checks for dev merge groups and keeps the PR and push triggers', () => {
    expect(ci.on.merge_group).toEqual({ branches: ['dev'], types: ['checks_requested'] });
    expect(ci.on.pull_request === null || ci.on.pull_request === '').toBe(true);
    expect(ci.on.push.branches).toEqual(['dev', 'main']);
    expect(ci.concurrency).toEqual({
      group: 'ci-${{ github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
  });

  test('uses the default Pocket debug key on merge groups', () => {
    const debugKey = ci.jobs.pocket.steps.find((step: any) => step.id === 'debug_key');
    expect(debugKey.name).toBe('Materialize the shared debug keystore');
    expect(debugKey.if).toBe("github.event_name != 'merge_group'");
  });
});

describe('the CI result job', () => {
  test('runs last, always reads every other job, and knows which jobs can skip', () => {
    expect(aggregate.name).toBe('CI result');
    expect(aggregate.if).toBe('always()');
    expect(Object.keys(ci.jobs).at(-1)).toBe('ci-result');
    expect(new Set(aggregate.needs).size).toBe(aggregate.needs.length);
    expect(aggregate.needs).toEqual(JOBS);
    expect(step.env.EVENT).toBe('${{ github.event_name }}');
    expect(step.env.RESULTS).toBe('${{ toJSON(needs) }}');
    const gated = [...step.run.matchAll(/^\s*\[([\w-]+)\]=([\w-]+)$/gm)];
    expect(gated).toHaveLength(Object.keys(GATED).length);
    expect(Object.fromEntries(gated.map(([, id, area]) => [id, area]))).toEqual(GATED);
  });

  for (const event of ['pull_request', 'push', 'workflow_dispatch', 'merge_group']) {
    test(`passes when every job succeeds on ${event}`, () => {
      const needs = Object.fromEntries(JOBS.map((id) => [id, { result: 'success' }]));
      const result = runResult(event, needs);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('| job | result |');
      expect(result.stdout).toContain('| boot | success |');
      expect(result.summary).toBe(result.stdout);
    });
  }

  test('passes a pull request that skips an unchanged area', () => {
    const result = runResult('pull_request', {
      changes: { result: 'success', outputs: { link: 'false' } },
      'pocket-link': { result: 'skipped' },
      'pocket-link-required': { result: 'success' },
    });
    expect(result.status).toBe(0);
    expect(result.summary).toContain('| pocket-link | skipped |');
  });

  test('passes a docs-only pull request with all gated jobs skipped', () => {
    const needs = Object.fromEntries(JOBS.map((id) => [
      id, { result: Object.hasOwn(GATED, id) ? 'skipped' : 'success' },
    ]));
    const result = runResult('pull_request', {
      ...needs,
      changes: { result: 'success', outputs: areaOutputs('false') },
    });
    expect(result.status).toBe(0);
  });

  for (const event of ['push', 'workflow_dispatch', 'merge_group']) {
    test(`fails a skipped area on ${event}`, () => {
      const result = runResult(event, {
        changes: { result: 'success', outputs: { pocket: 'false' } },
        pocket: { result: 'skipped' },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/::error::.*pocket \(skipped\)/);
    });
  }

  test('fails a skipped ungated job on a pull request', () => {
    const result = runResult('pull_request', {
      changes: { result: 'success', outputs: areaOutputs('false') },
      boot: { result: 'skipped' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/::error::.*boot \(skipped\)/);
  });

  test('fails a skipped area on a pull request without the string false', () => {
    for (const outputs of [{ pocket: 'true' }, { pocket: false }, { herdr: 'false' }]) {
      const result = runResult('pull_request', {
        changes: { result: 'success', outputs },
        pocket: { result: 'skipped' },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(/::error::.*pocket \(skipped\)/);
    }
  });

  for (const status of ['failure', 'cancelled', 'unknown']) {
    test(`fails and names a job with result ${status}`, () => {
      const result = runResult('pull_request', { boot: { result: status } });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::');
      expect(result.stdout).toContain(`boot (${status})`);
      expect(result.summary).toContain(`| boot | ${status} |`);
    });
  }

  test('fails a prerequisite failure and a skipped dependent', () => {
    const result = runResult('pull_request', {
      changes: { result: 'failure' },
      pocket: { result: 'skipped' },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/::error::.*changes \(failure\).*pocket \(skipped\)/);
  });

  test('fails on absent, empty or invalid results', () => {
    for (const needs of ['', '{}', 'not json']) {
      const result = runResult('pull_request', needs);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('::error::');
    }
  });
});

function git(dir: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...args],
    { cwd: dir, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function changedAreas(dir: string, event: string, base: string, head: string) {
  const output = join(dir, 'output');
  writeFileSync(output, '');
  const result = spawnSync('bash', ['-c', paths.run], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...ci.env,
      BASE: base,
      EVENT: event,
      HEAD_SHA: head,
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    },
  });
  if (result.status !== 0 || result.stdout.includes('::error::')) {
    throw new Error(`the changes script failed: ${result.stdout}${result.stderr}`);
  }
  const lines = readFileSync(output, 'utf8').trim().split('\n').filter(Boolean);
  return Object.fromEntries(lines.map((line) => line.split('=')));
}

test('a docs-only diff skips all areas on a pull request and checks all on a merge group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-result-git-'));
  try {
    git(dir, 'init', '-q');
    mkdirSync(join(dir, 'docs'));
    const doc = join(dir, 'docs', 'example.md');
    writeFileSync(doc, '# Example\n');
    git(dir, 'add', 'docs/example.md');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(doc, '# Updated example\n');
    git(dir, 'commit', '-q', '-am', 'docs only');
    const head = git(dir, 'rev-parse', 'HEAD');

    expect(changedAreas(dir, 'pull_request', base, head)).toEqual(areaOutputs('false'));
    expect(changedAreas(dir, 'merge_group', base, head)).toEqual(areaOutputs('true'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
