import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { issueBody, watch } from './watch';
import expectedPushes from './fixtures/watch/expected-pushes.json';
import unexpectedPushes from './fixtures/watch/unexpected-pushes.json';
import pulls from './fixtures/watch/pulls.json';
import incomplete from './fixtures/watch/incomplete.json';
import followOmni from './fixtures/watch/follow-omni.json';
import followOmniSkippedRelease from './fixtures/watch/follow-omni-skipped-release.json';
import partialEvidence from './fixtures/watch/partial-evidence.json';

const options = { now: '2026-11-20T12:00:00Z', appId: 42 };
const [cut, listing, bump] = expectedPushes.pushes;
const [release, follow] = expectedPushes.runs;

describe('App pushes to dev', () => {
  test('accepts the cut, its market index listing, and the Follow Omni bump', () => {
    const report = watch(expectedPushes, options);
    expect(report).toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });
    expect(issueBody(report)).toBe('');
  });

  const findings = [
    ['a release subject when there are no runs', /recorded the pushed SHA for the cut job/, []],
    ['two commits', /exactly one new commit/],
    ['a force push', /force_push/],
    ['a carry SHA recorded by a Release run', /no Follow Omni run recorded the pushed SHA for the carry job/],
    ['a cut when the run recorded a different SHA', /recorded the pushed SHA for the cut job/],
    ['a listing without listing evidence', /recorded the pushed SHA for the list job/],
    ['a non-release subject', /subject does not match/],
  ] as const;
  for (const [index, [name, reason, runs = unexpectedPushes.runs]] of findings.entries()) {
    test(`reports ${name}`, () => {
      const push = unexpectedPushes.pushes[index];
      const report = watch({ ...unexpectedPushes, runs, pushes: [push] }, options);
      expect(report.ok).toBe(false);
      expect(report.unexpectedPushes).toEqual([{ sha: push.after, reason: expect.stringMatching(reason) }]);
    });
  }

  test('ignores other actors and branches and honors an explicit App login', () => {
    const pushes = unexpectedPushes.pushes.slice(findings.length);
    const snapshot = { ...unexpectedPushes, pushes };
    expect(watch(snapshot, options).ok).toBe(true);
    const report = watch(snapshot, { ...options, appLogin: 'automagik-genie' });
    expect(report.unexpectedPushes.map(({ sha }) => sha)).toEqual([pushes[0].after]);
  });

  test('requires the first parent and the commit SHA to match the push', () => {
    const wrongParent = { ...cut.commits[0], parents: [bump.after, cut.before] };
    const wrongTip = { ...cut.commits[0], sha: bump.after };
    for (const [commit, reason] of [[wrongParent, /first parent/], [wrongTip, /pushed dev tip/]] as const) {
      const report = watch({ ...expectedPushes, pushes: [{ ...cut, commits: [commit] }] }, options);
      expect(report.unexpectedPushes).toEqual([{ sha: cut.after, reason: expect.stringMatching(reason) }]);
    }
  });

  test('accepts the bump, cut, and listing recorded by a single Follow Omni run', () => {
    expect(watch(followOmni, options)).toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });
  });

  test('accepts the bump when Follow Omni skipped its nested Release', () => {
    const snapshot = followOmniSkippedRelease;
    expect(snapshot.runs[0].pushed.map(({ job }) => job)).toEqual(['carry']);
    expect(watch(snapshot, options)).toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });

    const unrecordedCut = followOmni.pushes[1];
    expect(watch({ ...snapshot, pushes: [...snapshot.pushes, unrecordedCut] }, options).unexpectedPushes)
      .toEqual([{ sha: unrecordedCut.after, reason: expect.stringMatching(/recorded the pushed SHA for the cut job/) }]);
  });

  test('accepts a recorded bump pushed from a dev tip newer than the run head', () => {
    const [run] = followOmni.runs;
    const [push] = followOmni.pushes;
    expect(run.headSha).not.toBe(push.before);
    expect(watch({ ...followOmni, pushes: [push] }, options).ok).toBe(true);
  });

  test('accepts the recorded cut and listing after retries from newer dev tips', () => {
    const cutParent = 'd'.repeat(40);
    const listingParent = 'e'.repeat(40);
    const pushes = [
      { ...cut, before: cutParent, commits: [{ ...cut.commits[0], parents: [cutParent] }] },
      { ...listing, before: listingParent, commits: [{ ...listing.commits[0], parents: [listingParent] }] },
    ];
    expect(watch({ ...expectedPushes, pushes }, options).ok).toBe(true);
  });

  test('requires evidence from the job that matches the commit subject', () => {
    const run = { ...release, pushed: [{ job: 'list', sha: cut.after, attempt: 2 }] };
    expect(watch({ ...expectedPushes, runs: [run], pushes: [cut] }, options).unexpectedPushes)
      .toEqual([{ sha: cut.after, reason: expect.stringMatching(/recorded the pushed SHA for the cut job/) }]);
  });

  test('accepts a recorded listing on its own', () => {
    const runs = [{ ...release, pushed: release.pushed.filter(({ job }) => job === 'list') }];
    expect(watch({ ...expectedPushes, runs, pushes: [listing] }, options).ok).toBe(true);
  });

  test('requires the exact release version and subject', () => {
    for (const subject of ['', 'chore(release): v3.162.04', 'chore(release): v3.1000.4', 'chore(release): v3.162.4-rc.1']) {
      const pushes = [{ ...cut, commits: [{ ...cut.commits[0], subject }] }];
      expect(watch({ ...expectedPushes, pushes }, options).unexpectedPushes[0].reason).toMatch(/subject does not match/);
    }
    const subject = 'chore(release): list v3.162.04 in the market index';
    const pushes = [{ ...listing, commits: [{ ...listing.commits[0], subject }] }];
    expect(watch({ ...expectedPushes, pushes }, options).unexpectedPushes[0].reason).toMatch(/subject does not match/);
  });

  test('requires a record from a Release or Follow Omni run on dev', () => {
    const ineligibleRuns = [
      { ...release, headBranch: 'main' },
      { ...release, path: '.github/workflows/ci.yml' },
    ];
    for (const run of ineligibleRuns) {
      expect(watch({ ...expectedPushes, pushes: [cut], runs: [run] }, options).unexpectedPushes[0].reason)
        .toMatch(/recorded the pushed SHA for the cut job/);
    }
  });

  test('accepts a recorded cut while its run is queued for a rerun', () => {
    const runs = [{ ...release, status: 'queued', pushed: [{ ...release.pushed[0], attempt: 1 }] }];
    expect(watch({ ...expectedPushes, runs, pushes: [cut] }, options))
      .toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });
  });

  test('accepts a recorded cut even when the push timestamp follows the run update', () => {
    const runs = [{ ...release, updatedAt: release.createdAt }];
    expect(watch({ ...expectedPushes, runs, pushes: [cut] }, options).ok).toBe(true);
  });

  test('reports an unrecorded cut with complete evidence from a queued first attempt', () => {
    const runs = [{ ...release, status: 'queued', pushed: [] }];
    expect(watch({ ...expectedPushes, runs, pushes: [cut] }, options)).toEqual({
      stuck: [],
      unexpectedPushes: [{ sha: cut.after, reason: 'no Release or Follow Omni run recorded the pushed SHA for the cut job' }],
      incomplete: [],
      ok: false,
    });
  });

  test('ignores a human push with incomplete commits', () => {
    const push = { ...cut, actor: 'human', commits: [], commitsComplete: false };
    expect(watch({ ...expectedPushes, pushes: [push] }, options))
      .toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });
  });
});

describe('stuck pull requests', () => {
  test('reports missing and overdue checks on ready dev PRs, choosing the newest matching check', () => {
    const report = watch(pulls, options);
    expect(report.stuck.map(({ number }) => number)).toEqual([101, 102, 103, 108, 110, 112]);
    expect(report.stuck.map(({ reason }) => reason)).toEqual([
      'no pr-reviewer check on the current head',
      'no pr-reviewer check on the current head',
      'pr-reviewer check has been in_progress for over 60 minutes',
      'pr-reviewer check has been queued for over 60 minutes',
      'no pr-reviewer check on the current head',
      'pr-reviewer check has been in_progress for over 60 minutes',
    ]);
    expect(report.stuck[0].headSha).toBe(pulls.pulls[0].headSha);
  });

  test('suppresses overdue checks while Release or Follow Omni is queued or in progress', () => {
    for (const run of [{ ...release, status: 'in_progress' }, { ...follow, status: 'queued' }]) {
      expect(watch({ ...pulls, runs: [run] }, options).stuck.map(({ number }) => number)).toEqual([101, 102, 110]);
    }
  });

  test('ignores unrelated runs as evidence of a release wait', () => {
    const runs = [
      { ...release, path: '.github/workflows/ci.yml', status: 'in_progress' },
      { ...follow, headBranch: 'main', status: 'queued' },
      release,
    ];
    expect(watch({ ...pulls, runs }, options).stuck.map(({ number }) => number)).toEqual([101, 102, 103, 108, 110, 112]);
  });

  test('ignores unrelated checks with null or unusable start times', () => {
    const [check] = pulls.pulls[9].checkRuns;
    const pull = pulls.pulls[10];
    const unrelated = { ...check, startedAt: 'unusable', status: 'unrecognized' };
    const checkRuns = [check, unrelated, ...pull.checkRuns];
    expect(watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options).ok).toBe(true);
  });

  test('requires a known status and a start time for each matching waiting check', () => {
    const pull = pulls.pulls[10];
    const [latest, older] = pull.checkRuns;
    for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
      const checkRuns = [latest, { ...older, status, startedAt: null }];
      const report = watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options);
      expect(report.incomplete).toEqual(['PR #111 check status or start time']);
      expect(report.stuck).toEqual([]);
    }
    const checkRuns = [latest, { ...older, status: 'unrecognized' }];
    expect(watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options).incomplete)
      .toEqual(['PR #111 check status or start time']);
  });

  test('uses the higher check ID for equal start times in either order', () => {
    const pull = pulls.pulls[10];
    const [latest, overdue] = pull.checkRuns;
    const completed = { ...latest, startedAt: overdue.startedAt };
    for (const checkRuns of [[completed, overdue], [overdue, completed]]) {
      expect(watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options).ok).toBe(true);
    }
  });

  test('lets a completed check with a higher ID and null start time supersede an overdue check', () => {
    const pull = pulls.pulls[10];
    const [latest, overdue] = pull.checkRuns;
    const checkRuns = [overdue, { ...latest, startedAt: null }];
    expect(watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options).ok).toBe(true);
  });

  test('treats two observations of the newest check ID as incomplete, in either order', () => {
    const pull = pulls.pulls[10];
    const [, overdue] = pull.checkRuns;
    const completed = { ...overdue, status: 'completed' };
    for (const checkRuns of [[completed, overdue], [overdue, completed]]) {
      const report = watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options);
      expect(report.stuck).toEqual([]);
      expect(report.incomplete).toEqual([`PR #${pull.number} check ${overdue.id} observed twice`]);
      expect(report.ok).toBe(false);
    }
  });

  test('does not judge an overdue check while a release run is in an unknown status', () => {
    const pull = pulls.pulls[10];
    const [, overdue] = pull.checkRuns;
    const alone = { ...pulls, pulls: [{ ...pull, checkRuns: [overdue] }] };
    expect(watch(alone, options).stuck.map(entry => entry.number)).toEqual([pull.number]);
    const unknownRun = { ...release, status: 'unrecognized' };
    const report = watch({ ...alone, runs: [unknownRun] }, options);
    expect(report.stuck).toEqual([]);
    expect(report.incomplete).toEqual([`PR #${pull.number} release wait unknown`]);
    const waitingRun = { ...release, status: 'waiting' };
    expect(watch({ ...alone, runs: [unknownRun, waitingRun] }, options).incomplete).toEqual([]);
  });

  test('ignores incomplete check data for draft and non-dev PRs', () => {
    const outOfScope = pulls.pulls.slice(5, 7).map(pull => ({ ...pull, complete: false }));
    expect(watch({ ...pulls, pulls: outOfScope }, options))
      .toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });
  });

  test('compares instants even when timestamps use different time zones', () => {
    const pull = pulls.pulls[2];
    const check = { ...pull.checkRuns[0], startedAt: '2026-11-20T12:59:00+02:00' };
    const snapshot = { ...pulls, pulls: [{ ...pull, checkRuns: [check] }] };
    expect(watch(snapshot, options).stuck.map(({ number }) => number)).toEqual([103]);
  });
});

describe('partial snapshots and issue text', () => {
  test('lists incomplete parts and suppresses findings that depend on them', () => {
    expect(watch(incomplete, options)).toEqual({
      stuck: [], unexpectedPushes: [], incomplete: ['runs', 'pushes', 'PR #201 check runs'], ok: false,
    });
    const merged = { ...unexpectedPushes, pulls: pulls.pulls };
    const withoutRuns = watch({ ...merged, complete: { ...merged.complete, runs: false } }, options);
    expect(withoutRuns.stuck.map(({ number }) => number)).toEqual([101, 102, 110]);
    expect(withoutRuns.unexpectedPushes).toEqual([]);
    expect(withoutRuns.incomplete).toEqual(['runs']);
    const withoutPulls = watch({ ...merged, complete: { ...merged.complete, pulls: false } }, options);
    expect(withoutPulls.stuck).toEqual([]);
    expect(withoutPulls.unexpectedPushes).toHaveLength(7);
    const withoutPushes = watch({ ...merged, complete: { ...merged.complete, pushes: false } }, options);
    expect(withoutPushes.stuck).toHaveLength(6);
    expect(withoutPushes.unexpectedPushes).toEqual([]);
  });

  test('reports missing check data, actor, commits, and run evidence alongside independent findings', () => {
    const [unknownActor, missingCommits, missingRunEvidence, wrongSha] = partialEvidence.pushes;
    const report = watch(partialEvidence, options);
    expect(report.incomplete).toEqual([
      'PR #202 check status or start time',
      'PR #203 check status or start time',
      `push ${unknownActor.after} actor`,
      `push ${missingCommits.after} commits`,
      `push ${missingRunEvidence.after} run evidence`,
      `push ${wrongSha.after} run evidence`,
    ]);
    expect(report.stuck.map(({ number }) => number)).toEqual([101]);
    expect(report.unexpectedPushes).toEqual([]);
    expect(report.ok).toBe(false);
  });

  test('reports a null actor on dev even when the push has a matching job record', () => {
    const push = { ...cut, actor: null };
    expect(watch({ ...expectedPushes, pushes: [push] }, options)).toEqual({
      stuck: [], unexpectedPushes: [], incomplete: [`push ${push.after} actor`], ok: false,
    });
  });

  test('accepts a matching record when run evidence is incomplete', () => {
    for (const runs of [
      [release, { ...release, id: 8, evidenceComplete: false, pushed: [] }],
      [{ ...release, evidenceComplete: false }],
    ]) {
      expect(watch({ ...expectedPushes, runs, pushes: [cut] }, options))
        .toEqual({ stuck: [], unexpectedPushes: [], incomplete: [], ok: true });
    }
  });

  test('reports missing evidence when no run recorded the push and any run has incomplete evidence', () => {
    const runs = [{ ...follow, evidenceComplete: false }];
    const report = watch({ ...expectedPushes, runs, pushes: [cut] }, options);
    expect(report.incomplete).toEqual([`push ${cut.after} run evidence`]);
    expect(report.unexpectedPushes).toEqual([]);
  });

  test('renders the PR numbers, commit SHAs, reasons, and missing data for the watch issue', () => {
    const snapshot = {
      ...unexpectedPushes,
      pulls: [pulls.pulls[0], incomplete.pulls[0]],
      pushes: unexpectedPushes.pushes.slice(0, 1),
    };
    const body = issueBody(watch(snapshot, options));
    expect(body).toContain(`- #101 at \`${pulls.pulls[0].headSha}\` — no pr-reviewer check on the current head`);
    expect(body).toContain(`- \`${unexpectedPushes.pushes[0].after}\` — no Release or Follow Omni run recorded the pushed SHA for the cut job`);
    expect(body).toContain('- PR #201 check runs');
  });
});

describe('snapshot validation', () => {
  test('points to unknown, missing, or mistyped fields', () => {
    expect(() => watch({ ...expectedPushes, extra: true }, options)).toThrow(/snapshot\.extra is unknown/);
    expect(() => watch({ ...expectedPushes, complete: { pushes: true, runs: true } }, options))
      .toThrow(/snapshot\.complete\.pulls is required/);
    expect(() => watch({ ...pulls, pulls: [{ ...pulls.pulls[0], draft: 'false' }] }, options))
      .toThrow(/snapshot\.pulls\[0\]\.draft must be a boolean/);
    const pushes = [{ ...cut, commits: [{ ...cut.commits[0], parents: ['bad'] }] }];
    expect(() => watch({ ...expectedPushes, pushes }, options))
      .toThrow(/snapshot\.pushes\[0\]\.commits\[0\]\.parents\[0\]/);
    for (const appId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => watch(expectedPushes, { ...options, appId })).toThrow(/options\.appId/);
    }
    expect(() => watch(expectedPushes, { ...options, appLogin: ' ' })).toThrow(/options\.appLogin/);
  });

  test('requires a positive integer ID for each check run', () => {
    const pull = pulls.pulls[2];
    const [{ id, ...check }] = pull.checkRuns;
    expect(() => watch({ ...pulls, pulls: [{ ...pull, checkRuns: [check] }] }, options))
      .toThrow(/snapshot\.pulls\[0\]\.checkRuns\[0\]\.id is required/);
    for (const invalidId of [0, -id, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const checkRuns = [{ ...check, id: invalidId }];
      expect(() => watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options))
        .toThrow(/snapshot\.pulls\[0\]\.checkRuns\[0\]\.id must be a positive integer/);
    }
  });

  test('validates push and run evidence fields', () => {
    const evidence = release.pushed[0];
    for (const [field, value] of [['job', 'deploy'], ['sha', 'bad'], ['attempt', 0]] as const) {
      const runs = [{ ...release, pushed: [{ ...evidence, [field]: value }] }];
      expect(() => watch({ ...expectedPushes, runs }, options))
        .toThrow(`snapshot.runs[0].pushed[0].${field}`);
    }
    expect(() => watch({ ...expectedPushes, runs: [{ ...release, evidenceComplete: 'false' }] }, options))
      .toThrow(/snapshot\.runs\[0\]\.evidenceComplete must be a boolean/);
    expect(() => watch({ ...expectedPushes, pushes: [{ ...cut, commitsComplete: 'false' }] }, options))
      .toThrow(/snapshot\.pushes\[0\]\.commitsComplete must be a boolean/);
  });

  test('rejects invalid times even when Date.parse would normalize them', () => {
    for (const now of ['November 20, 2026', '2026-02-30T12:00:00Z', '2026-11-20T12:00:00', 'invalid']) {
      expect(() => watch(expectedPushes, { ...options, now })).toThrow(/options\.now/);
    }
    const pull = pulls.pulls[2];
    const checkRuns = [{ ...pull.checkRuns[0], startedAt: '2026-11-20T12:99:00Z' }];
    expect(() => watch({ ...pulls, pulls: [{ ...pull, checkRuns }] }, options))
      .toThrow(/snapshot\.pulls\[0\]\.checkRuns\[0\]\.startedAt/);
    expect(() => watch({ ...expectedPushes, runs: [{ ...release, updatedAt: 'bad' }] }, options))
      .toThrow(/snapshot\.runs\[0\]\.updatedAt/);
    expect(() => watch({ ...expectedPushes, pushes: [{ ...cut, timestamp: 'bad' }] }, options))
      .toThrow(/snapshot\.pushes\[0\]\.timestamp/);
  });
});

describe('watch CLI', () => {
  function run(fixture: string, now = options.now) {
    return Bun.spawnSync([
      process.execPath, join(import.meta.dir, 'watch.ts'), join(import.meta.dir, 'fixtures', 'watch', fixture),
      '--now', now, '--app-id', String(options.appId),
    ]);
  }

  for (const [fixture, snapshot, exitCode] of [
    ['expected-pushes.json', expectedPushes, 0],
    ['unexpected-pushes.json', unexpectedPushes, 1],
    ['incomplete.json', incomplete, 2],
    ['partial-evidence.json', partialEvidence, 2],
  ] as const) {
    test(`prints the report and exits ${exitCode} for ${fixture}`, () => {
      const result = run(fixture);
      expect(result.stderr.toString()).toBe('');
      expect(result.exitCode).toBe(exitCode);
      expect(JSON.parse(result.stdout.toString())).toEqual(watch(snapshot, options));
    });
  }

  test('exits 2 with a field-specific error for invalid input', () => {
    const result = run('expected-pushes.json', 'invalid');
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toMatch(/options\.now/);
    expect(result.stdout.toString()).toBe('');
  });
});
