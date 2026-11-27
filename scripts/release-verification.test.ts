import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { herdrFiles, passed, verificationPlan } from './release-verification.mjs';

const root = join(import.meta.dir, '..');
const workflow = (name: string) => Bun.YAML.parse(readFileSync(join(root, '.github/workflows', name + '.yml'), 'utf8'));

test('the parallel gates cover every Herdr test exactly once, including a new file', () => {
  const files = readdirSync(join(root, 'herdr/test')).filter(n => n.endsWith('.test.mjs')).concat('future.test.mjs');
  const plan = verificationPlan({ ships: 'yes', herdr: 'yes', meter: 'yes', pocket: 'yes' }, 'full', 'scope');
  const checks = ['base', 'am', 'herdr-static', 'meter', 'pocket'];
  const assignments = plan.filter(({ gate }) => !checks.includes(gate));
  expect(assignments.flatMap(({ gate }) => herdrFiles(files, gate)).sort()).toEqual(files.sort());
  expect(plan.filter(({ key }) => key === 'scope').map(({ gate }) => gate)).toEqual(['accounts-fleet', 'restart', 'revive', 'worker']);
  expect(plan.filter(({ gate }) => checks.includes(gate)).map(({ gate }) => gate).sort()).toEqual(checks.sort());
  expect(verificationPlan({ ships: 'yes' }, 'full', '').map(({ gate }) => gate)).toEqual(['base', 'am']);
  expect(verificationPlan({ ships: 'no' }, 'full', '')).toEqual([]);
});

test('the archived tree carries shared verification inputs across a Bot-only merge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verification-tree-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const tree = () => execFileSync(process.execPath, ['--eval',
    `import { scopedTree } from ${JSON.stringify(join(root, 'scripts/release-verification.mjs'))}; console.log(scopedTree())`],
    { cwd: dir, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git('-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-qm', 'fixture');
  };
  try {
    git('init', '-q');
    for (const path of ['herdr', 'apps/bots-dsh', '.github/workflows', 'scripts']) mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, 'herdr/source.js'), 'source');
    writeFileSync(join(dir, 'apps/bots-dsh/package.json'), '{}');
    commit();
    const initial = tree();
    writeFileSync(join(dir, 'apps/bots-dsh/package.json'), '{"change":true}');
    commit();
    expect(tree()).toBe(initial);
    expect(git('ls-tree', '-r', '--name-only', initial)).toBe('herdr/source.js');
    let prior = initial;
    for (const file of ['.github/workflows/release.yml', '.github/node-versions.json', 'scripts/release-gates.sh', 'herdr/source.js']) {
      writeFileSync(join(dir, file), 'changed');
      commit();
      const current = tree();
      expect(current).not.toBe(prior);
      prior = current;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only a successful, executed verification on the same runner image can be reused', () => {
  const job = { name: 'Verify worker key', conclusion: 'success', steps: [{ name: 'Verified on image', conclusion: 'success' }] };
  expect(passed([job], job.name, 'image')).toBe(true);
  expect(passed([job], job.name, 'new-image')).toBe(false);
  expect(passed([job], 'Verify worker different', 'image')).toBe(false);
  expect(passed([{ ...job, conclusion: 'cancelled' }], job.name, 'image')).toBe(false);
  expect(passed([{ ...job, steps: [{ ...job.steps[0], conclusion: 'skipped' }] }], job.name, 'image')).toBe(false);
});

test('only the publisher locks release-cut and its checkout is pinned to successful verification', () => {
  const { jobs } = workflow('release');
  const verify = workflow('release-verify').jobs.verify;
  expect(jobs.cut.needs).toBe('preflight');
  expect(jobs.preflight.uses).toBe('./.github/workflows/release-verify.yml');
  expect(jobs.cut.concurrency).toMatchObject({ group: 'release-cut', queue: 'max' });
  expect(jobs.cut.steps.find(s => s.uses?.includes('checkout@')).with.ref).toBe('${{ needs.preflight.outputs.sha }}');
  expect(verify.steps.find(s => s.uses?.includes('checkout@')).with.ref).toBe('${{ needs.plan.outputs.sha }}');
  expect(verify.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(verify.concurrency.group).not.toBe('release-cut');
  expect(jobs.cut.steps.find(s => s.id === 'cut').env.RELEASE_CUT_ATTEMPTS).toBe(1);
});

test('publication summary distinguishes the feed, release alone, tagged failure, and successor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publication-summary-'));
  try {
    const file = join(dir, 'summary');
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\necho https://github.com/example/repo/actions/runs/42\n');
    chmodSync(join(dir, 'gh'), 0o755);
    function summary(env: Record<string, string>) {
      writeFileSync(file, '');
      execFileSync('bash', [join(root, 'scripts/release-summary.sh')], { env: {
        PATH: dir + ':' + process.env.PATH, GITHUB_REPOSITORY: 'example/repo', GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_STEP_SUMMARY: file, RESULT: 'success', ...env,
      } });
      return readFileSync(file, 'utf8');
    }
    expect(summary({})).toContain('No changes to publish');
    expect(summary({ RESULT: 'failure' })).toContain('did not reach publication');
    expect(summary({ VERSION: '3.4.1', PUBLISHED: 'failure' })).toContain('publication was not confirmed');
    expect(summary({ VERSION: '3.4.1', PUBLISHED: 'success', FEED: 'success' })).toContain('plugin-lane/lane.json.sig');
    expect(summary({ VERSION: '3.4.1', PUBLISHED: 'success', FEED: 'failure' })).toContain('feed publication was not confirmed');
    expect(summary({ SUCCESSOR: 'a'.repeat(40) })).toContain('successor release run](https://github.com/example/repo/actions/runs/42)');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
