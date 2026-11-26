// Follow Omni carries at most one Omni a UTC day (#371): its "Once a UTC day" step, run as written
// in a real git repository and with a fixed clock, holds a candidate when the commit by which dev
// last moved omni.json (along dev's first parents: a squash, a push, or a true merge at its merge
// time) was committed today (UTC), and the jobs are wired so a held candidate still boots but is
// never carried.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('keeps the dispatch fast path, the outside daily clock, the schedule backstop and shared concurrency', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['repository_dispatch', 'schedule', 'workflow_dispatch', 'workflow_run']);
    expect(workflow.on.repository_dispatch).toEqual({ types: ['omni-release', 'daily-carry'] });
    expect(workflow.on.schedule).toEqual([{ cron: '11,41 * * * *' }]);
    expect(workflow.concurrency).toEqual({ group: 'follow-omni', 'cancel-in-progress': false });
  });

  test('a daily-carry dispatch is the clock, not an Omni hint: it looks the newest Omni up itself', () => {
    const newest = runOf('The newest Omni release');
    // Only Omni's own dispatch logs (and waits for) a hinted release; the daily clock has none.
    expect(newest).toContain('"${EVENT_ACTION}" == omni-release');
    expect(jobOf('follow').map(line => line.trim())).toContain('EVENT_ACTION: ${{ github.event.action }}');
    // The hold still decides whether that run carries: the dispatch adds no skip input.
    expect(workflow.on.repository_dispatch.types).toContain('daily-carry');
    expect(workflow.on.workflow_dispatch.inputs.skip_daily_hold.default).toBe(false);
  });

  test('a daily-carry dispatch never reads Omni\'s payload as a hint; omni-release still does', () => {
    const newest = runOf('The newest Omni release');
    const hint = newest.split('\n');
    const start = hint.findIndex(line => line.includes('GITHUB_EVENT_NAME}" == repository_dispatch'));
    expect(start).toBeGreaterThan(-1);
    const indent = hint[start].length - hint[start].trimStart().length;
    const end = hint.findIndex((line, i) => i > start && line.trim() === 'fi' && line.length - line.trimStart().length === indent);
    expect(end).toBeGreaterThan(start);
    const block = hint.slice(start, end + 1).join('\n');
    const prelude = 'set -euo pipefail\nlookup() { :; }\nabove() { return 1; }\nnewest=2.261115.8\n';
    const run = (action: string) => spawnSync('bash', ['-c', `${prelude}\n${block}`], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_EVENT_NAME: 'repository_dispatch',
        EVENT_ACTION: action,
        HINT_VERSION: '2.261115.9',
        HINT_TAG: 'v2.261115.9',
        HINT_SHA: '36c548a556887514c65874b385f33d3f6ef968d2',
        GITHUB_STEP_SUMMARY: '/dev/null',
      },
    });
    const daily = run('daily-carry');
    expect(daily.status).toBe(0);
    expect(daily.stdout).toBe('');
    const omni = run('omni-release');
    expect(omni.status).toBe(0);
    expect(omni.stdout).toContain('Omni dispatched 2.261115.9');
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

// The newest step, run as written with a stand-in `gh`: from its top to where it has chosen
// `newest`, then the plugin check on that release. Omni's releases of February 2026 were
// 2.YYYYMMDD.N, which sort -V ranks above every 2.YYMMDD.N since (#1564).
describe('Follow Omni\'s candidate', () => {
  const step = runOf('The newest Omni release');
  const cut = step.indexOf('read_json() {');
  const choose = step.slice(0, cut);
  const check = step.slice(cut, step.indexOf('\ndone\n', cut) + '\ndone\n'.length);
  const legacy = ['2.20260216.5', '2.20260221.1'];

  type Choice = { pin?: string; releases?: string[]; want?: string; dryRun?: boolean };
  function candidate({ pin = '2.261120.2', releases = [], want = '', dryRun = false }: Choice) {
    const dir = mkdtempSync(join(tmpdir(), 'follow-omni-candidate-'));
    try {
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'apps', 'desktop'), { recursive: true });
      writeFileSync(join(dir, 'apps', 'desktop', 'omni.json'), JSON.stringify({ version: pin }));
      writeFileSync(join(dir, 'versions'), releases.map(version => `${version}\n`).join(''));
      writeFileSync(join(dir, 'requests'), '');
      writeFileSync(join(dir, 'bin', 'gh'), '#!/usr/bin/env bash\necho "$*" >> requests\ncat versions\n', { mode: 0o755 });
      const run = spawnSync('bash', ['-c', `${choose}\nprintf 'selected=%s\\n' "$newest"`], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
          OMNI: 'automagik-si/omni',
          DRY_RUN: dryRun ? 'true' : 'false',
          WANT_VERSION: want,
          WANT_COMMIT: '',
          WANT_DEV: '',
          SKIP_HOLD: 'false',
          GITHUB_EVENT_NAME: want ? 'workflow_dispatch' : 'schedule',
          EVENT_ACTION: '',
          GITHUB_STEP_SUMMARY: '/dev/null',
        },
      });
      return { status: run.status, out: run.stdout.trim(), asked: readFileSync(join(dir, 'requests'), 'utf8') !== '' };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // The plugin check for the release `newest`, Omni's two plugins at the given versions
  // (`undefined`: its package.json cannot be read).
  function plugins(newest: string, versions: { channels?: string; canvas?: string }) {
    const dir = mkdtempSync(join(tmpdir(), 'follow-omni-plugins-'));
    try {
      mkdirSync(join(dir, 'bin'));
      for (const [app, version] of [['omni-channels-dsh', versions.channels], ['omni-canvas-dsh', versions.canvas]] as const) {
        if (version !== undefined) writeFileSync(join(dir, `${app}.json`), JSON.stringify({ version }));
      }
      writeFileSync(join(dir, 'requests'), '');
      writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash
set -euo pipefail
echo "$2" >> requests
[[ "$1" == api && "$3 $4" == '--jq .content' ]]
app="\${2#repos/automagik-si/omni/contents/apps/}"
app="\${app%%/*}"
[[ "$2" == "repos/automagik-si/omni/contents/apps/\${app}/package.json?ref=v\${newest}" ]]
base64 "\${app}.json"
`, { mode: 0o755 });
      const run = spawnSync('bash', ['-c', `set -euo pipefail\n${check}\necho passed`], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, OMNI: 'automagik-si/omni', newest },
      });
      return { status: run.status, out: run.stdout.trim(), requests: readFileSync(join(dir, 'requests'), 'utf8').trim().split('\n') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('is found as the workflow writes it', () => {
    expect(cut).toBeGreaterThan(-1);
    expect(choose).toContain('newest="${WANT_VERSION}"');
    expect(choose).toContain('# follow: end');
    expect(check).toContain('for app in omni-channels-dsh omni-canvas-dsh; do');
    expect(check).toContain('not following it');
  });

  test('a legacy date-style release is never the candidate, wherever the list has it', () => {
    const current = ['2.261120.2', '2.261121.9', '2.261121.12'];
    for (const releases of [[...legacy, ...current], [...current.toReversed(), ...legacy.toReversed()]]) {
      expect(candidate({ releases })).toEqual({ status: 0, out: 'selected=2.261121.12', asked: true });
    }
  });

  test('never lower than the pin: a legacy release beside a pin at or above every current one is not followed', () => {
    const lists: [string[], string][] = [
      [[...legacy, '2.261119.2', '2.261120.2'], '2.261120.2'],
      [['2.261119.2', ...legacy], '2.261119.2'],
      [legacy, 'none'],
    ];
    for (const [releases, newest] of lists) {
      expect(candidate({ releases })).toEqual({ status: 0, out: `Omni ${newest}: omni.json is at 2.261120.2, nothing to follow`, asked: true });
    }
  });

  test('omni_version is the candidate as given with dry_run, also one that is not newer, and the releases are not read', () => {
    for (const want of ['2.261121.12', '2.261119.2', '2.261120.2', '2.20260221.1']) {
      expect(candidate({ want, dryRun: true, releases: [...legacy, '2.261121.12'] })).toEqual({ status: 0, out: `selected=${want}`, asked: false });
    }
  });

  test('omni_version is refused without dry_run, and when it is not a release version', () => {
    const real = candidate({ want: '2.261121.12', releases: ['2.261121.12'] });
    expect(real.status).toBe(1);
    expect(real.out).toContain('::error ::omni_version, omni_commit and dev_sha are only taken with dry_run');
    expect(real.asked).toBe(false);
    for (const want of ['v2.261121.12', '2.261121', '2.261121.12-rc.1', '2.261121.12\nversion=x']) {
      const run = candidate({ want, dryRun: true });
      expect(run.status).toBe(1);
      expect(run.out).toBe('::error ::omni_version is not a release version (x.y.z)');
      expect(run.asked).toBe(false);
    }
  });

  test('the plugins at or below their release pass, read at that release\'s tag', () => {
    const run = plugins('2.261121.12', { channels: '2.261121.12', canvas: '2.261121.6' });
    expect(run).toEqual({
      status: 0,
      out: 'passed',
      requests: [
        'repos/automagik-si/omni/contents/apps/omni-channels-dsh/package.json?ref=v2.261121.12',
        'repos/automagik-si/omni/contents/apps/omni-canvas-dsh/package.json?ref=v2.261121.12',
      ],
    });
  });

  test('a plugin ahead of its release, or unreadable, is not followed', () => {
    const ahead = plugins('2.261121.12', { channels: '2.261121.13', canvas: '2.261121.6' });
    expect(ahead.status).toBe(0);
    expect(ahead.out).toBe("::notice ::Omni 2.261121.12: omni-channels-dsh is at '2.261121.13', ahead of its release or unreadable: not following it");
    const canvas = plugins('2.261121.12', { channels: '2.261121.12', canvas: '2.261122.1' });
    expect(canvas.status).toBe(0);
    expect(canvas.out).toBe("::notice ::Omni 2.261121.12: omni-canvas-dsh is at '2.261122.1', ahead of its release or unreadable: not following it");
    const unreadable = plugins('2.261121.12', { canvas: '2.261121.6' });
    expect(unreadable.status).toBe(0);
    expect(unreadable.out).toBe("::notice ::Omni 2.261121.12: omni-channels-dsh is at '', ahead of its release or unreadable: not following it");
  });

  test('the plugin check stays as strict across the two schemes: a legacy version beside a current release is refused', () => {
    const run = plugins('2.261121.12', { channels: '2.20260221.1', canvas: '2.261121.6' });
    expect(run.status).toBe(0);
    expect(run.out).toBe("::notice ::Omni 2.261121.12: omni-channels-dsh is at '2.20260221.1', ahead of its release or unreadable: not following it");
    // A legacy release given by omni_version is checked against its own plugins, in its scheme.
    expect(plugins('2.20260221.1', { channels: '2.20260220.6', canvas: '2.20260221.1' }).out).toBe('passed');
  });
});

// Follow Omni pushes its bump with GITHUB_TOKEN, so no CI run tests the pin it carries before a
// release is cut on it: v3.172.0 went out with a welcome test red on dev. The boot job
// (boot-check.yml, called with the candidate) writes the candidate pin as carry does and runs the
// tests that read the pin on it; carry, which makes the commit, needs that job.
describe('Follow Omni tests the candidate pin before it commits it', () => {
  const root = join(import.meta.dir, '..');
  const workflow = Bun.YAML.parse(lines.join('\n')) as any;
  const boot = (Bun.YAML.parse(readFileSync(join(root, '.github', 'workflows', 'boot-check.yml'), 'utf8')) as any).jobs.boot;
  const steps: any[] = boot.steps;
  const at = (name: string) => steps.findIndex(step => step.name === name);
  const name = 'The tests that read the pin';
  const tests = steps[at(name)];

  test('the step runs on a candidate, on the pin written as carry writes it', () => {
    expect(tests).toBeDefined();
    expect(tests.if).toBe("inputs.omni_version != ''");
    const written = steps[at('The candidate Omni')];
    expect(written.if).toBe("inputs.omni_version != ''");
    for (const file of ['apps/desktop/omni.json', 'apps/welcome-dsh/package.json']) expect(written.run).toContain(file);
    expect(at(name)).toBeGreaterThan(at('The candidate Omni'));
    // The welcome's tests need the installed harness, and its tool list the candidate's plugins.
    expect(at(name)).toBeGreaterThan(at('Install'));
    expect(at(name)).toBeGreaterThan(at("Omni's plugins at the candidate"));
    expect(steps[at("Omni's plugins at the candidate")].run).toContain('origin "${OMNI_COMMIT}"');
  });

  test('it runs the tests that read omni.json or the welcome\'s pin', () => {
    const listed = [
      'apps/desktop/test/version.test.js',
      'test/bot-types.test.js',
      'test/install-resolved.test.js',
      'test/omni-github-contract.test.js',
      'test/release-resolve.test.js',
    ];
    for (const file of listed) expect(tests.run).toContain(file);
    expect(tests.run).toContain('cd apps/welcome-dsh\n');
    // A welcome test that names the pin (OMNI_RELEASE) is in the step: a new one is added here.
    const welcome = join(root, 'apps', 'welcome-dsh', 'test');
    const naming = readdirSync(welcome)
      .filter(file => file.endsWith('.test.js') && readFileSync(join(welcome, file), 'utf8').includes('OMNI_RELEASE'))
      .map(file => `test/${file}`);
    expect(naming).toContain('test/release-resolve.test.js');
    for (const file of naming) expect(tests.run).toContain(file);
  });

  test('a failing test fails the boot job, and carry never runs without that job', () => {
    for (const part of [tests, boot, workflow.jobs.boot]) expect(part['continue-on-error']).toBeUndefined();
    expect(workflow.jobs.boot.uses).toBe('./.github/workflows/boot-check.yml');
    expect(workflow.jobs.boot.with).toEqual({
      ref: '${{ needs.follow.outputs.dev }}',
      omni_version: '${{ needs.follow.outputs.version }}',
      omni_commit: '${{ needs.follow.outputs.commit }}',
    });
    expect(workflow.jobs.carry.needs).toEqual(['follow', 'boot']);
    // No status function in carry's `if`: a failed or skipped boot job skips it.
    expect(ifOf('carry')).not.toMatch(/always|failure|cancelled|success/);
    // The commit is made in carry alone, on the dev commit the boot job tested.
    expect(lines.filter(line => line.includes('git commit')).length).toBe(1);
    expect(runOf('Move omni.json and the welcome to it')).toContain('git commit');
    expect(jobOf('carry').map(line => line.trim())).toContain('ref: ${{ needs.follow.outputs.dev }}');
  });

  // The step as written, with stand-ins for node and bun that log their arguments; `fail` is a
  // word of the command line that makes the stand-in fail.
  function runStep(fail = '') {
    const dir = mkdtempSync(join(tmpdir(), 'follow-omni-pin-tests-'));
    try {
      mkdirSync(join(dir, 'bin'));
      mkdirSync(join(dir, 'apps', 'welcome-dsh'), { recursive: true });
      const standIn = '#!/usr/bin/env bash\necho "$(basename "$0") $*" >> "$CALLS"\n[[ -z "$FAIL" || " $* " != *" $FAIL "* ]]\n';
      for (const bin of ['node', 'bun']) writeFileSync(join(dir, 'bin', bin), standIn, { mode: 0o755 });
      const calls = join(dir, 'calls');
      writeFileSync(calls, '');
      const run = spawnSync('/bin/bash', ['-c', tests.run], {
        cwd: dir,
        encoding: 'utf8',
        env: { PATH: `${join(dir, 'bin')}:/usr/bin:/bin`, CALLS: calls, FAIL: fail },
      });
      return { status: run.status, calls: readFileSync(calls, 'utf8').trim().split('\n') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('as written, it runs the desktop test, installs the welcome and runs its tests', () => {
    expect(runStep()).toEqual({
      status: 0,
      calls: [
        'node --test apps/desktop/test/version.test.js',
        'bun install --frozen-lockfile --ignore-scripts',
        'node --import ./test/harness-resolve.mjs --test test/bot-types.test.js test/install-resolved.test.js test/omni-github-contract.test.js test/release-resolve.test.js',
      ],
    });
  });

  test('as written, any failure stops it: nothing later runs and the step fails', () => {
    const desktop = runStep('apps/desktop/test/version.test.js');
    expect(desktop.status).not.toBe(0);
    expect(desktop.calls).toEqual(['node --test apps/desktop/test/version.test.js']);
    const install = runStep('install');
    expect(install.status).not.toBe(0);
    expect(install.calls.length).toBe(2);
    const welcome = runStep('test/release-resolve.test.js');
    expect(welcome.status).not.toBe(0);
    expect(welcome.calls.length).toBe(3);
  });
});
