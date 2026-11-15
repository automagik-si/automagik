// Follow Omni carries at most one Omni a UTC day (#371): its "Once a UTC day" step, run as written
// in a real git repository and with a fixed clock, holds a candidate when the commit by which dev
// last moved omni.json (along dev's first parents: a squash, a push, or a true merge at its merge
// time) was committed today (UTC), and the jobs are wired so a held candidate still boots but is
// never carried.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const lines = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'follow-omni.yml'), 'utf8').split('\n');
const indent = (line: string) => line.length - line.trimStart().length;

// The `run: |` block of the step named `name`, dedented.
function runOf(name: string): string {
  const step = lines.findIndex(line => line.trim() === `- name: ${name}`);
  if (step < 0) return '';
  const run = lines.findIndex((line, i) => i > step && line.trim() === 'run: |');
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && indent(line) <= indent(lines[run])) break;
    body.push(line);
  }
  const by = Math.min(...body.filter(line => line.trim() !== '').map(indent));
  return body.map(line => line.slice(by)).join('\n');
}

// The lines of the job named `name`, up to the next job.
function jobOf(name: string): string[] {
  const at = lines.indexOf(`  ${name}:`);
  if (at < 0) return [];
  const end = lines.findIndex((line, i) => i > at && /^ {2}[a-z-]+:$/.test(line));
  return lines.slice(at, end < 0 ? undefined : end);
}
const ifOf = (job: string) => jobOf(job).find(line => /^ {4}if: /.test(line))?.trim();

describe('Follow Omni triggers', () => {
  const workflow = Bun.YAML.parse(lines.join('\n')) as any;
  const release = Bun.YAML.parse(readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8')) as any;

  test('checks after only completed Release runs on dev, regardless of conclusion', () => {
    expect(release.name).toBe('Release');
    expect(workflow.on.workflow_run).toEqual({
      workflows: [release.name],
      types: ['completed'],
      branches: ['dev'],
    });
    expect(workflow.jobs.follow.if).toBeUndefined();
  });

  test('keeps the dispatch fast path, schedule fallback and shared concurrency', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['repository_dispatch', 'schedule', 'workflow_dispatch', 'workflow_run']);
    expect(workflow.on.repository_dispatch).toEqual({ types: ['omni-release'] });
    expect(workflow.on.schedule).toEqual([{ cron: '11,41 * * * *' }]);
    expect(workflow.concurrency).toEqual({ group: 'follow-omni', 'cancel-in-progress': false });
  });
});

// dev's history after a first commit on 2026-10-01 that adds omni.json (`omni: false` leaves it
// out): commits made on dev at a committer date, moving omni.json or another file, and true merges
// (`--no-ff`) of a branch whose own commits are dated earlier. `name` keeps a commit's sha.
type Commit = { at: string; omni?: boolean; name?: string };
type Step = Commit | { merge: string; branch: Commit[]; name?: string };
type Hold = { history?: Step[]; omni?: boolean; today: string; dryRun?: boolean; skip?: boolean; repo?: boolean; event?: string };

function hold({ history = [], omni = true, today, dryRun = false, skip = false, repo = true, event = 'schedule' }: Hold) {
  const dir = mkdtempSync(join(tmpdir(), 'follow-omni-'));
  const bin = join(dir, 'bin');
  const work = join(dir, 'dev');
  mkdirSync(bin);
  mkdirSync(join(work, 'apps', 'desktop'), { recursive: true });
  writeFileSync(join(bin, 'date'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/date.log"\necho "${today}"\n`);
  chmodSync(join(bin, 'date'), 0o755);
  const base = { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (args: string[], at = '2026-10-01T00:00:00Z') => {
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: work, encoding: 'utf8', env: { ...base, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  let n = 0;
  const commit = ({ at, omni: moves = false }: Commit) => {
    n += 1;
    writeFileSync(join(work, moves ? 'apps/desktop/omni.json' : 'other'), `${n}\n`);
    git(['add', '-A']);
    git(['commit', '-qm', `commit ${n}`], at);
    return git(['rev-parse', 'HEAD']);
  };
  const shas: Record<string, string> = {};
  if (repo) {
    git(['init', '-q', '-b', 'dev']);
    commit({ at: '2026-10-01T00:00:00Z', omni });
    for (const step of history) {
      if ('merge' in step) {
        const branch = `branch${n}`;
        git(['checkout', '-qb', branch]);
        for (const c of step.branch) { const sha = commit(c); if (c.name) shas[c.name] = sha; }
        git(['checkout', '-q', 'dev']);
        git(['merge', '-q', '--no-ff', branch, '-m', 'Merge pull request'], step.merge);
        if (step.name) shas[step.name] = git(['rev-parse', 'HEAD']);
      } else {
        const sha = commit(step);
        if (step.name) shas[step.name] = sha;
      }
    }
  }
  writeFileSync(join(dir, 'output'), '');
  writeFileSync(join(dir, 'summary'), '');
  const run = spawnSync('bash', ['-c', runOf('Once a UTC day')], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...base,
      PATH: `${bin}:${base.PATH}`,
      VERSION: '2.261105.4',
      DRY_RUN: dryRun ? 'true' : 'false',
      SKIP_HOLD: skip ? 'true' : 'false',
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: join(dir, 'output'),
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    },
  });
  const read = (name: string) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
  const result = { status: run.status, out: run.stdout, err: run.stderr, output: read('output'), summary: read('summary'), date: read('date.log').trim(), shas };
  rmSync(dir, { recursive: true, force: true });
  return result;
}
const short = (sha: string) => sha.slice(0, 9);

describe('Follow Omni once a UTC day', () => {
  test('a completed release still holds today and carries after UTC midnight', () => {
    const history = [{ at: '2026-11-05T09:12:40Z', omni: true }];
    const today = hold({ history, today: '2026-11-05', event: 'workflow_run' });
    expect(today.status).toBe(0);
    expect(today.output).toBe('held=true\n');
    const tomorrow = hold({ history, today: '2026-11-06', event: 'workflow_run' });
    expect(tomorrow.status).toBe(0);
    expect(tomorrow.output).toBe('held=false\n');
  });

  test('is found as the workflow writes it', () => {
    expect(runOf('Once a UTC day')).toContain('held=false');
  });

  test('reads the clock in UTC', () => {
    expect(hold({ today: '2026-11-05' }).date).toBe('-u +%F');
  });

  test('omni.json last moved yesterday: it carries, naming the commit', () => {
    const run = hold({ history: [{ at: '2026-11-04T22:31:12Z', omni: true, name: 'carry' }, { at: '2026-11-05T08:00:00Z' }], today: '2026-11-05' });
    expect(run.status).toBe(0);
    expect(run.output).toBe('held=false\n');
    expect(run.summary).toBe(`### omni.json last moved 2026-11-04 at 22:31Z (${short(run.shas.carry)}), not today (2026-11-05 UTC): carrying Omni 2.261105.4 once it boots\n`);
  });

  test('a carry at 23:50Z yesterday, the clock on the next day: it carries', () => {
    expect(hold({ history: [{ at: '2026-11-04T23:50:00Z', omni: true }], today: '2026-11-05' }).output).toBe('held=false\n');
  });

  test('omni.json moved today (this workflow\'s push, or a squash merged by hand): it holds, and says until when', () => {
    const run = hold({ history: [{ at: '2026-11-04T22:31:12Z', omni: true }, { at: '2026-11-05T09:12:40Z', omni: true, name: 'carry' }], today: '2026-11-05' });
    expect(run.status).toBe(0);
    expect(run.output).toBe('held=true\n');
    expect(run.summary).toBe(`### Omni 2.261105.4 held: omni.json moved today at 09:12Z (${short(run.shas.carry)}); it boots but is not carried. The first run after 00:00 UTC (the 00:11 schedule) carries the newest Omni\n`);
  });

  test('the day is UTC: a commit at 22:30 -03:00 yesterday was committed 01:30Z today, and holds', () => {
    const run = hold({ history: [{ at: '2026-11-04T22:30:00-03:00', omni: true }], today: '2026-11-05' });
    expect(run.output).toBe('held=true\n');
    expect(run.summary).toContain('omni.json moved today at 01:30Z');
  });

  test('a true merge counts at its merge time: a carry committed yesterday on its branch and merged today holds', () => {
    const run = hold({ history: [{ merge: '2026-11-05T09:00:00Z', branch: [{ at: '2026-11-04T12:00:00Z', omni: true }], name: 'merge' }], today: '2026-11-05' });
    expect(run.output).toBe('held=true\n');
    expect(run.summary).toContain(`omni.json moved today at 09:00Z (${short(run.shas.merge)})`);
  });

  test('a squash-style commit and a true merge side by side: each spends the day it was committed on dev', () => {
    // Yesterday a carry was squashed onto dev; today a merge lands whose branch commit, dated
    // yesterday, touches no omni.json: nothing moved omni.json today.
    const quiet = hold({ history: [{ at: '2026-11-04T10:00:00Z', omni: true }, { merge: '2026-11-05T09:00:00Z', branch: [{ at: '2026-11-04T11:00:00Z' }] }], today: '2026-11-05' });
    expect(quiet.output).toBe('held=false\n');
    // The same, but today's merge brings a carry its branch committed yesterday: today is spent.
    const merged = hold({ history: [{ at: '2026-11-04T10:00:00Z', omni: true }, { merge: '2026-11-05T09:00:00Z', branch: [{ at: '2026-11-04T11:00:00Z', omni: true }] }], today: '2026-11-05' });
    expect(merged.output).toBe('held=true\n');
  });

  test('omni.json never moved on dev: it carries', () => {
    const run = hold({ omni: false, history: [{ at: '2026-11-05T08:00:00Z' }], today: '2026-11-05' });
    expect(run.status).toBe(0);
    expect(run.output).toBe('held=false\n');
    expect(run.summary).toBe('### omni.json was never moved on dev: carrying Omni 2.261105.4 once it boots\n');
  });

  test('dev\'s history cannot be read: the run fails and nothing is decided', () => {
    const run = hold({ repo: false, today: '2026-11-05' });
    expect(run.status).not.toBe(0);
    expect(run.output).toBe('');
  });

  test('a dry run is never held, and reports what a real run would do', () => {
    const today = hold({ history: [{ at: '2026-11-05T09:12:40Z', omni: true, name: 'carry' }], today: '2026-11-05', dryRun: true });
    expect(today.output).toBe('held=false\n');
    expect(today.summary).toBe(`### Dry run: a real run would hold Omni 2.261105.4: omni.json moved today at 09:12Z (${short(today.shas.carry)})\n`);
    const yesterday = hold({ history: [{ at: '2026-11-04T22:31:12Z', omni: true }], today: '2026-11-05', dryRun: true });
    expect(yesterday.output).toBe('held=false\n');
    expect(yesterday.summary).toContain('a real run would carry Omni 2.261105.4');
  });

  test('skip_daily_hold carries a second Omni the same day, with a warning', () => {
    const run = hold({ history: [{ at: '2026-11-05T09:12:40Z', omni: true, name: 'carry' }], today: '2026-11-05', skip: true });
    expect(run.output).toBe('held=false\n');
    expect(run.out).toContain(`::warning ::Daily hold skipped by hand: carrying Omni 2.261105.4 although omni.json moved today at 09:12Z (${short(run.shas.carry)})`);
  });
});

describe('Follow Omni\'s inputs', () => {
  // The newest step's input checks, up to where it starts reading anything.
  const newest = runOf('The newest Omni release');
  const checks = newest.slice(0, newest.indexOf('# Dispatch inputs reach GITHUB_OUTPUT'));
  const check = (env: Record<string, string>) => spawnSync('bash', ['-c', checks], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', WANT_VERSION: '', WANT_COMMIT: '', WANT_DEV: '', ...env } });

  test('skip_daily_hold is refused with dry_run, and taken without it', () => {
    expect(checks).toContain('skip_daily_hold');
    const refused = check({ DRY_RUN: 'true', SKIP_HOLD: 'true' });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('::error ::skip_daily_hold is not taken with dry_run');
    expect(check({ DRY_RUN: 'false', SKIP_HOLD: 'true' }).status).toBe(0);
    expect(check({ DRY_RUN: 'true', SKIP_HOLD: 'false' }).status).toBe(0);
  });

  test('skip_daily_hold is a dispatch input that defaults to off, read into the follow job', () => {
    const at = lines.findIndex(line => line.trim() === 'skip_daily_hold:');
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at, at + 4).map(line => line.trim())).toContain('default: false');
    expect(jobOf('follow').map(line => line.trim())).toContain("SKIP_HOLD: ${{ inputs.skip_daily_hold && 'true' || 'false' }}");
  });
});

describe('Follow Omni\'s jobs around the hold', () => {
  test('follow checks out dev with its whole history, so the first-parent log sees every carry', () => {
    const follow = jobOf('follow').map(line => line.trim());
    expect(follow).toContain('ref: dev');
    expect(follow).toContain('fetch-depth: 0');
  });

  test('follow exposes held from the hold step', () => {
    expect(jobOf('follow').map(line => line.trim())).toContain('held: ${{ steps.hold.outputs.held }}');
  });

  test('a held candidate still boots: the boot job does not look at held', () => {
    expect(ifOf('boot')).toBe("if: needs.follow.outputs.version != ''");
  });

  test('a held candidate is never carried', () => {
    expect(ifOf('carry')).toBe("if: needs.follow.outputs.version != '' && needs.follow.outputs.held != 'true'");
  });

  test('the release still follows only a carried bump, never a dry run', () => {
    expect(ifOf('release')).toBe("if: needs.carry.outputs.sha != '' && !inputs.dry_run");
    expect(jobOf('release').map(line => line.trim())).toContain('needs: carry');
  });
});
