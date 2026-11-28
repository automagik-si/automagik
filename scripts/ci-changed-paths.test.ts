// CI decides what changed in one `changes` job and every heavy job reads its output in a
// job-level `if`, so an unchanged area is skipped instead of claiming a runner to check out and
// skip. This keeps that wiring honest: a job-level `if` naming an output the `changes` job does
// not write, a leftover `steps.changed` reference (it would skip every step of the job), or a
// detection rule that drifted would skip a check instead of running it (#895). It also pins
// fail-open: a failed `changes` job leaves its outputs empty, and a gated job must skip only an
// explicit `false`, so a red detector runs the area instead of hiding it behind a skipped check.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const ci = Bun.YAML.parse(
  readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8'),
) as any;

const changes = ci.jobs.changes;
const paths = changes.steps.find((step: any) => step.id === 'paths');

/** The gated job's id, and the `changes` output its job-level `if` reads. */
const GATED: Record<string, string> = {
  herdr: 'herdr',
  scheduler: 'scheduler',
  am: 'am',
  pocket: 'pocket',
  'pocket-link': 'link',
  meter: 'meter',
  usagemeter: 'usagemeter',
  'dsh-sandbox': 'sandbox',
  'runner-vm': 'runnervm',
  id: 'id',
  'brand-font': 'font',
};
const AREAS = Object.values(GATED);

/**
 * The area the `changes` script records, and its rule: [variable, a path the rule matches, a
 * path another area owns].
 */
const RULES: Record<string, [string, string, string]> = {
  herdr: ['HERDR_CHANGED_PATHS', 'herdr/x', 'apps/x'],
  scheduler: ['SCHEDULER_CHANGED_PATHS', 'herdr/scheduler/x', 'herdr/x'],
  am: ['AM_CHANGED_PATHS', 'am/x', 'apps/x'],
  pocket: ['POCKET_CHANGED_PATHS', 'apps/pocket/x', 'apps/x'],
  link: ['POCKET_LINK_CHANGED_PATHS', 'herdr/mods/pocket-link/x', 'herdr/x'],
  meter: ['METER_CHANGED_PATHS', 'meter/statusline/x', 'meter/usagemeter/x'],
  usagemeter: ['USAGEMETER_CHANGED_PATHS', 'meter/usagemeter/x', 'meter/statusline/x'],
  sandbox: ['SANDBOX_CHANGED_PATHS', 'apps/dsh-sandbox/x', 'apps/x'],
  runnervm: ['RUNNER_VM_CHANGED_PATHS', 'am/runner/spawn.mjs', 'am/bin/am'],
  id: ['ID_CHANGED_PATHS', 'apps/id/x', 'apps/landing/x'],
  font: ['BRAND_FONT_CHANGED_PATHS', 'scripts/brand-font/rebuild.mjs', 'docs/brand/tokens/tokens.json'],
};

/** The inputs each rule carries beyond its own folder, which must still count as a change. */
const CROSS = [
  ['HERDR_CHANGED_PATHS', 'herdr-layout/layouts/automagik.json'],
  ['HERDR_CHANGED_PATHS', 'scripts/lane.ts'],
  ['HERDR_CHANGED_PATHS', '.github/node-versions.json'],
  ['SCHEDULER_CHANGED_PATHS', '.github/workflows/ci.yml'],
  ['AM_CHANGED_PATHS', 'herdr/mods/am-sidebar/bin/run.sh'],
  ['AM_CHANGED_PATHS', '.github/node-versions.json'],
  ['POCKET_CHANGED_PATHS', 'package.json'],
  ['POCKET_LINK_CHANGED_PATHS', 'herdr/test/fixtures/transcript-folder-rule.json'],
  ['USAGEMETER_CHANGED_PATHS', 'meter/schema/query/v1/envelope.schema.json'],
  ['METER_CHANGED_PATHS', '.github/workflows/ci.yml'],
  ['SANDBOX_CHANGED_PATHS', '.github/workflows/ci.yml'],
  ['RUNNER_VM_CHANGED_PATHS', 'am/test/vm-run.sh'],
  ['RUNNER_VM_CHANGED_PATHS', 'apps/bots-dsh/src/host/runner-client.js'],
  ['RUNNER_VM_CHANGED_PATHS', 'apps/bots-dsh/src/host/bot-shell.js'],
  ['RUNNER_VM_CHANGED_PATHS', 'apps/bots-dsh/src/shared/registry.js'],
  ['RUNNER_VM_CHANGED_PATHS', 'apps/bots-dsh/test/member-wall-probe.test.js'],
  ['RUNNER_VM_CHANGED_PATHS', 'apps/bots-dsh/test/harness-resolve.mjs'],
  ['RUNNER_VM_CHANGED_PATHS', 'apps/bots-dsh/dev/harness/package.json'],
  ['RUNNER_VM_CHANGED_PATHS', '.github/scripts/apt-canonical-sources.sh'],
  ['RUNNER_VM_CHANGED_PATHS', '.github/workflows/ci.yml'],
  ['RUNNER_VM_CHANGED_PATHS', '.github/node-versions.json'],
  ['ID_CHANGED_PATHS', '.github/workflows/ci.yml'],
  ['ID_CHANGED_PATHS', '.github/scripts/apt-canonical-sources.sh'],
  ['BRAND_FONT_CHANGED_PATHS', 'docs/brand/fonts/fredoka-latin.woff2'],
  ['BRAND_FONT_CHANGED_PATHS', 'docs/brand/fonts/README.md'],
  ['BRAND_FONT_CHANGED_PATHS', '.github/workflows/ci.yml'],
];

/** Runs the `changes` job's real script the way the runner does, with an output file. */
function decide(
  { event = 'pull_request', base = '', head = '', cwd = REPO }:
    { event?: string; base?: string; head?: string; cwd?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changed-paths-'));
  try {
    const output = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const result = spawnSync('bash', ['-c', paths.run], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...ci.env,
        BASE: base,
        EVENT: event,
        HEAD_SHA: head,
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    if (result.status !== 0 || result.stdout.includes('::error::')) {
      throw new Error(`the changes script failed: ${result.stdout}${result.stderr}`);
    }
    const lines = readFileSync(output, 'utf8').trim().split('\n').filter(Boolean);
    const outputs = Object.fromEntries(lines.map((line) => line.split('=')));
    return { ...result, outputs, summary: readFileSync(summary, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir: string, ...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...args],
    { cwd: dir, encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A throwaway repository: one commit per tree, so a base...head range is real. */
function scratchRepo(trees: Record<string, string>[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-changed-paths-git-'));
  git(dir, 'init', '-q');
  const commits: string[] = [];
  for (const [index, tree] of trees.entries()) {
    for (const [path, content] of Object.entries(tree)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `tree ${index}`);
    commits.push(git(dir, 'rev-parse', 'HEAD'));
  }
  return { dir, commits };
}

describe('the changes job', () => {
  test('writes one output per gated area, and is the only job that decides paths', () => {
    expect(Object.keys(changes.outputs).sort()).toEqual([...AREAS].sort());
    for (const area of AREAS) {
      expect(changes.outputs[area]).toBe(`\${{ steps.paths.outputs.${area} }}`);
    }
    // The old Linux-only Pocket Link detector is this job's `link` output now.
    expect(ci.jobs['pocket-link-changes']).toBeUndefined();
    // `git diff BASE...HEAD` needs the base commit locally, so the checkout keeps its history.
    expect(changes.steps[0].with['fetch-depth']).toBe(0);
  });

  test('is the first job, and a push or a manual run checks every area', () => {
    expect(Object.keys(ci.jobs)[0]).toBe('changes');
    expect(ci.on.workflow_dispatch).toBeDefined();
    // No git call and no diff: a base that cannot be compared is not even reached.
    for (const event of ['push', 'workflow_dispatch']) {
      const result = decide({ event, base: 'not-a-commit' });
      expect(result.outputs).toEqual(Object.fromEntries(AREAS.map((area) => [area, 'true'])));
      expect(result.summary).toContain('| herdr | true |');
    }
  });

  test('checks every area when the base this checkout has cannot be compared', () => {
    const base = '0'.repeat(40);
    const result = decide({ event: 'pull_request', base, head: git(REPO, 'rev-parse', 'HEAD') });
    expect(result.outputs).toEqual(Object.fromEntries(AREAS.map((area) => [area, 'true'])));
  });

  test('on a pull request, only the areas whose rule matches the diff are true', () => {
    const { dir, commits } = scratchRepo([
      { 'README.md': 'first\n' },
      { 'apps/bots-dsh/src/host/bot.js': 'export {};\n' },
      { 'meter/statusline/statusline.mjs': 'export {};\n' },
    ]);
    try {
      // Every rule reads the pull request's head (HEAD_SHA); the job also checks it out.
      git(dir, 'checkout', '-q', '--detach', commits[1]);
      const botsOnly = decide({ base: commits[0], head: commits[1], cwd: dir });
      for (const area of AREAS) expect(botsOnly.outputs[area]).toBe('false');

      git(dir, 'checkout', '-q', '--detach', commits[2]);
      const withMeter = decide({ base: commits[0], head: commits[2], cwd: dir });
      expect(withMeter.outputs.meter).toBe('true');
      expect(withMeter.outputs.herdr).toBe('false');
      expect(withMeter.outputs.pocket).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an ID-only pull request checks ID alone, and its job asserts the steps it gates', () => {
    const { dir, commits: [base, head] } = scratchRepo([
      { 'README.md': 'first\n' },
      { 'apps/id/src/index.ts': 'export {};\n' },
    ]);
    try {
      const { outputs } = decide({ base, head, cwd: dir });
      for (const area of AREAS) expect(outputs[area]).toBe(area === 'id' ? 'true' : 'false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const steps = ci.jobs.id.steps;
    // The second read of the diff (#895) needs the base commit, so the checkout keeps history.
    expect(steps[0].with['fetch-depth']).toBe(0);
    const assert = steps.find((step: any) => step.name === 'Assert the steps ran');
    expect(assert.if).toBe('always()');
    expect(assert.run).toContain('grep -E "${ID_CHANGED_PATHS}"');
    for (const id of ['check', 'test', 'mutations']) {
      expect(steps.some((step: any) => step.id === id)).toBe(true);
      expect(assert.env.OUTCOMES).toContain(`${id}=\${{ steps.${id}.outcome }}`);
    }
  });

  test('reads only the pull request, not base commits newer than its base.sha', () => {
    // GitHub checks out a merge with today's base, while the event's base.sha can be the
    // older base the pull request was opened on: a release bump on the base since then must
    // not mark herdr, am, Pocket or usagemeter as changed on a docs-only pull request.
    const { dir, commits: [base] } = scratchRepo([{ 'README.md': 'first\n' }]);
    try {
      git(dir, 'checkout', '-q', '-b', 'pr');
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs', 'note.md'), 'docs only\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'docs only');
      const docsHead = git(dir, 'rev-parse', 'HEAD');
      git(dir, 'checkout', '-q', '--detach', base);
      for (const path of ['package.json', 'herdr/package.json', 'am/VERSION', 'meter/usagemeter/Cargo.toml']) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), '3.165.0\n');
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'release bump on the base');
      git(dir, 'merge', '-q', '--no-ff', '-m', 'merge', docsHead);
      const docsOnly = decide({ base, head: docsHead, cwd: dir });
      for (const area of AREAS) expect(docsOnly.outputs[area]).toBe('false');

      // The same base move under a pull request that does touch herdr/ still checks herdr.
      git(dir, 'checkout', '-q', 'pr');
      writeFileSync(join(dir, 'README.md'), 'second\n');
      mkdirSync(join(dir, 'herdr'), { recursive: true });
      writeFileSync(join(dir, 'herdr', 'x.mjs'), 'export {};\n');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'herdr change');
      const herdrHead = git(dir, 'rev-parse', 'HEAD');
      const herdr = decide({ base, head: herdrHead, cwd: dir });
      expect(herdr.outputs.herdr).toBe('true');
      expect(herdr.outputs.pocket).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('moving the runner VM script away still checks the runner VM', () => {
    // Rename detection would list only the new name, which the rule does not match.
    const { dir, commits: [base] } = scratchRepo([
      { 'README.md': 'first\n', 'am/test/vm-run.sh': '#!/bin/sh\necho rows\n' },
    ]);
    try {
      git(dir, 'mv', 'am/test/vm-run.sh', 'am/test/rows.sh');
      git(dir, 'commit', '-q', '-m', 'move the VM script');
      const head = git(dir, 'rev-parse', 'HEAD');
      const { outputs } = decide({ base, head, cwd: dir });
      expect(outputs.runnervm).toBe('true');
      expect(outputs.herdr).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const assert = ci.jobs['runner-vm'].steps.find((step: any) => step.name === 'Assert the steps ran');
    expect(assert.run).toContain('git diff --no-renames --name-only');
  });

  test('a schema-only pull request checks Pocket and usagemeter', () => {
    const { dir, commits: [base, head] } = scratchRepo([
      { 'README.md': 'first\n' },
      { 'meter/schema/fixtures/full.json': '{}\n' },
    ]);
    try {
      const { outputs } = decide({ base, head, cwd: dir });
      expect(outputs.pocket).toBe('true');
      expect(outputs.usagemeter).toBe('true');
      expect(outputs.meter).toBe('false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Evaluates a job-level `if` for the expression subset this workflow uses. */
function jobWouldRun(
  condition: string,
  { outputs = {}, cancelled = false }:
    { outputs?: Record<string, string>; cancelled?: boolean } = {},
) {
  const expression = condition.replace(/^\s*\$\{\{\s*/, '').replace(/\s*\}\}\s*$/, '');
  // `!cancelled()`, `&&`, `!=` and the output paths are valid JavaScript too; GitHub evaluates
  // this subset the same way, an empty output included (it is not the string 'false').
  const evaluate = new Function('needs', 'cancelled', `return (${expression});`);
  return Boolean(evaluate({ changes: { outputs } }, () => cancelled));
}

describe('a gated job', () => {
  test('is fail-open: only an explicit false output skips the area', () => {
    for (const [id, area] of Object.entries(GATED)) {
      const gated = ci.jobs[id];
      expect([gated.needs].flat()).toContain('changes');
      // A failed `changes` job leaves its outputs empty; that must run the area, not hide it.
      expect(jobWouldRun(gated.if, { outputs: {} })).toBe(true);
      // A successful detection still runs a changed area and skips an unchanged one.
      expect(jobWouldRun(gated.if, { outputs: { [area]: 'true' } })).toBe(true);
      expect(jobWouldRun(gated.if, { outputs: { [area]: 'false' } })).toBe(false);
      // A cancelled run is the one case that still stops every gated job.
      expect(jobWouldRun(gated.if, { outputs: {}, cancelled: true })).toBe(false);
      expect(gated.if).toBe(
        `\${{ !cancelled() && needs.changes.outputs.${area} != 'false' }}`,
      );
      // The detection step lives in `changes`: a leftover reference would skip every step.
      expect(JSON.stringify(gated.steps)).not.toContain('steps.changed');
    }
  });

  test('keeps recognizable names, including distinct Herdr shards', () => {
    for (const id of Object.keys(GATED)) expect(ci.jobs[id].name).toBeDefined();
    expect(ci.jobs.herdr.name).toBe(
      'herdr pack (Node ${{ matrix.node }}, shard ${{ matrix.shard }}/2)',
    );
    expect(ci.jobs.herdr.strategy.matrix.shard).toEqual([1, 2]);
    expect(ci.jobs['pocket-link'].name).toBe('Pocket Link bridge (${{ matrix.os }})');
    expect(ci.jobs.usagemeter.name).toBe('usagemeter (${{ matrix.os }})');
    expect(ci.jobs.meter.name).toBe('Meter status line');
    expect(ci.jobs.id.name).toBe('Automagik ID (local Workers runtime)');
    expect(ci.jobs['brand-font'].name).toBe('Brand font rebuild');
    expect(ci.jobs['runner-vm'].name).toBe('Member runner on a throwaway VM');
  });

  test('reads a rule defined once, with the cross-area inputs each rule carries', () => {
    const defined = Object.keys(ci.env).filter((name) => name.endsWith('_CHANGED_PATHS'));
    expect(defined.sort()).toEqual(Object.values(RULES).map(([name]) => name).sort());
    for (const [id, body] of Object.entries<any>(ci.jobs)) {
      for (const name of defined) {
        expect(body.env?.[name], `${id} must not redefine ${name}`).toBeUndefined();
      }
    }
    for (const [area, [name, yes, no]] of Object.entries(RULES)) {
      const pattern = new RegExp(ci.env[name]);
      expect(pattern.test(yes)).toBe(true);
      expect(pattern.test(no)).toBe(false);
      expect(paths.run).toContain(`grep_area ${area} "\${${name}}"`);
    }
    for (const [name, path] of CROSS) {
      expect(new RegExp(ci.env[name]).test(path)).toBe(true);
    }
  });
});

describe('the brand font gate', () => {
  test('a font-only pull request checks the font alone, and its job asserts the rebuild', () => {
    const { dir, commits: [base, head] } = scratchRepo([
      { 'README.md': 'first\n' },
      { 'docs/brand/fonts/fredoka-latin.woff2': 'font\n' },
    ]);
    try {
      const { outputs } = decide({ base, head, cwd: dir });
      for (const area of AREAS) expect(outputs[area]).toBe(area === 'font' ? 'true' : 'false');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const steps = ci.jobs['brand-font'].steps;
    // The second read of the diff (#895) needs the base commit, so the checkout keeps history.
    expect(steps[0].with['fetch-depth']).toBe(0);
    const assert = steps.find((step: any) => step.name === 'Assert the steps ran');
    expect(assert.if).toBe('always()');
    expect(assert.run).toContain('grep -E "${BRAND_FONT_CHANGED_PATHS}"');
    expect(steps.some((step: any) => step.id === 'rebuild')).toBe(true);
    expect(assert.env.OUTCOMES).toBe('rebuild=${{ steps.rebuild.outcome }}');
  });
});

describe('the Pocket Link aggregate', () => {
  test('still fails when detection or coverage is missing, and still skips a safe skip', () => {
    const required = ci.jobs['pocket-link-required'];
    expect(required.needs).toEqual(['changes', 'pocket-link']);
    expect(required.if).toBe('always()');
    const step = required.steps[0];
    expect(step.env.DETECTION).toBe('${{ needs.changes.result }}');
    expect(step.env.CHANGED).toBe('${{ needs.changes.outputs.link }}');
    expect(step.env.TESTS).toBe('${{ needs.pocket-link.result }}');
    expect(step.run).toContain('false:skipped');
  });
});
