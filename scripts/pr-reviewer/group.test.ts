/** RFC 0029 D3a part 3: exercise the head gate, CI attempt history, and release waits. */
import { expect, test } from 'bun:test';
import nodeVersions from '../../.github/node-versions.json';
import { gateHead, verifyGroup } from './group';
import type { Rules } from './rules';

type GroupInput = Parameters<typeof verifyGroup>[0];
type Job = GroupInput['jobs'][number];
type ReleaseRun = GroupInput['release']['runs'][number];

const headSha = 'a'.repeat(40);
const groupSha = 'b'.repeat(40);
const rebuiltSha = 'c'.repeat(40);
const runId = 42;
const releasePath = '.github/workflows/release.yml';
const followOmniPath = '.github/workflows/follow-omni.yml';
const linuxLink = 'Pocket Link bridge (ubuntu-24.04)';
const bootCheck = "Boot / Boot with Omni's plugins";

// The check-run names for every job in ci.yml, including every matrix leg
// and the called job in boot-check.yml.
const matrixJobs = [
  ...nodeVersions.ci.flatMap(node =>
    [1, 2].map(shard => `herdr pack (Node ${node}, shard ${shard}/2)`)),
  ...nodeVersions.ci.map(node => `am (Node ${node})`),
  linuxLink,
  'Pocket Link bridge (macos-latest)',
  'usagemeter (ubuntu-24.04)',
  'usagemeter (macos-latest)',
  ...['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'multiuser-dsh', 'vault-dsh', 'welcome-dsh']
    .map(app => `${app} (plugin tests)`),
  'Desktop (main-process tests)',
  'Desktop (main-process tests, windows)',
];
const ciJobs = [
  'Changed paths',
  'Node versions',
  'Versions and market index',
  'Landing page and browser',
  'Brand font rebuild',
  'Automagik ID (local Workers runtime)',
  'Privacy (whole repository)',
  'Scheduler (Go)',
  'Pocket (build, test, lint)',
  'Pocket Link bridge',
  'Meter status line',
  'dsh-sandbox runner',
  'vault-dsh (native macOS Keychain)',
  'acp-dsh (real Codex image reads) · required integration',
  'automagik-pets (tests)',
  'acp-dsh (Windows spawns)',
  'vault-keychain-macos',
  bootCheck,
  'CI result',
  ...matrixJobs,
];

function snapshot(): GroupInput {
  return {
    head: { sha: headSha, state: 'pass' },
    queueEntry: { headSha, groupSha },
    run: { id: runId, headSha: groupSha, status: 'completed', attempt: 1, complete: true },
    jobs: ciJobs.map((name, index) => ({
      id: index + 1, runId, headSha: groupSha, name, attempt: 1, status: 'completed', conclusion: 'success',
    })),
    expectedJobs: ciJobs,
    release: {
      runs: [{
        id: 20, path: releasePath, status: 'completed', conclusion: 'success',
        createdAt: '2026-11-19T13:00:00Z', releaseRan: true,
      }],
      newestId: 20,
      newestJobs: [{ name: 'cut', conclusion: 'success' }, { name: 'plugin lane', conclusion: 'skipped' }],
      complete: true,
    },
  };
}

test('passes a full green CI group with skipped release jobs and unrelated active workflows', () => {
  const input = snapshot();
  input.release.runs = [...input.release.runs, {
    id: 21, path: '.github/workflows/ci.yml', status: 'queued', conclusion: null,
    createdAt: '2026-11-19T14:00:00Z', releaseRan: false,
  }];
  expect(verifyGroup(input)).toEqual({ state: 'pass', reasons: [] });
});

test('binds the real gate result to the PR head and requires its approvals and results', () => {
  const rules: Rules = {
    version: 1, ownerReview: { billing: [], keys: [], release: [], reviewer: [] },
    wordMatch: { notBilling: [] }, holdLabels: [],
  };
  const evidence: Parameters<typeof gateHead>[0] = {
    headSha, base: 'dev', draft: false, labels: [], verdict: { kind: 'SHIP', sha: headSha },
    results: { sha: headSha, checks: [], statuses: [] },
    complete: { results: true, reviews: true, files: true },
    appId: 7, classification: { ownerReview: [], askOwner: [] },
    ownerApprovedHead: false, authorCanWrite: false, teamApprovedHead: true,
  };
  const head = gateHead(evidence, rules);
  expect(head).toEqual({ sha: headSha, state: 'pass' });
  expect(verifyGroup({ ...snapshot(), head }).state).toBe('pass');
  expect(gateHead({ ...evidence, teamApprovedHead: false }, rules).state).toBe('action_required');
  expect(gateHead({ ...evidence, results: { ...evidence.results, sha: groupSha } }, rules).state).toBe('wait');
});

test.each([
  ['wait', 'wait'],
  ['action_required', 'wait'],
  ['fail', 'fail'],
] as const)('maps head gate %s to %s', (state, expected) => {
  expect(verifyGroup({ ...snapshot(), head: { sha: headSha, state } })).toEqual({
    state: expected, reasons: [`PR head gate is ${state}`],
  });
});

test('fails a merge group for a different PR head', () => {
  expect(verifyGroup({ ...snapshot(), head: { sha: rebuiltSha, state: 'pass' } })).toEqual({
    state: 'fail', reasons: ['merge group is for another PR head'],
  });
});

test('fails a rebuilt group with the previous CI run or its old job rows', () => {
  const input = snapshot();
  input.queueEntry.groupSha = rebuiltSha;
  expect(verifyGroup(input).state).toBe('fail');
  input.run = { ...input.run, id: runId + 1, headSha: rebuiltSha };
  expect(verifyGroup(input).state).toBe('fail');
});

test.each([
  { runId: runId + 1 },
  { headSha: rebuiltSha },
])('fails a single CI job bound to other evidence (%j)', fields => {
  const input = snapshot();
  input.jobs = input.jobs.map(job => job.name === linuxLink ? { ...job, ...fields } : job);
  expect(verifyGroup(input).state).toBe('fail');
});

test.each(matrixJobs)('fails when complete CI omits the exact check %s', missing => {
  const input = snapshot();
  input.jobs = input.jobs.filter(job => job.name !== missing);
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: [`merge group is missing expected job ${missing}`],
  });
});

test('a bare workflow name cannot satisfy the reusable Boot check', () => {
  const input = snapshot();
  input.jobs = input.jobs.map(job => job.name === bootCheck ? { ...job, name: 'Boot' } : job);
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: ['merge group is missing expected job ' + bootCheck],
  });
});

test('waits while a dependent job has yet to be scheduled in an active CI run', () => {
  const input = snapshot();
  input.run.status = 'in_progress';
  input.jobs = input.jobs.filter(job => job.name !== linuxLink)
    .map(job => job.name === 'CI result' ? { ...job, conclusion: null, status: 'queued' } : job);
  expect(verifyGroup(input).state).toBe('wait');
});

test('waits for a rerun whose job rows have yet to arrive', () => {
  const input = snapshot();
  input.run.attempt = 2;
  for (const status of ['queued', 'completed']) {
    input.run.status = status;
    expect(verifyGroup(input).state).toBe('wait');
  }
});

test.each([
  ['cancelled', 1],
  ['cancelled', 2],
  ['skipped', 1],
] as const)('fails a %s matrix leg with a green parent and CI result in attempt %i', (conclusion, attempt) => {
  const input = snapshot();
  input.run.attempt = attempt;
  input.jobs = input.jobs.map(job => {
    if (job.name === linuxLink) return { ...job, conclusion };
    if (job.name === 'CI result') return { ...job, attempt };
    return job;
  });
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: [`merge group job ${linuxLink} concluded ${conclusion}`],
  });
});

test.each([
  ['completed', 'cancelled', 'concluded cancelled'],
  ['in_progress', null, 'is in_progress'],
] as const)('checks both same-name jobs in the newest attempt in either order (%s)', (status, conclusion, reason) => {
  const input = snapshot();
  input.run.attempt = 2;
  const success: Job = { ...input.jobs.find(job => job.name === linuxLink)!, id: 100, attempt: 2 };
  const bad: Job = { ...success, id: 101, status, conclusion };
  const firstAttempt = input.jobs;
  for (const rows of [[success, bad], [bad, success]]) {
    input.jobs = [...firstAttempt, ...rows];
    expect(verifyGroup(input)).toEqual({
      state: 'fail', reasons: [`merge group job ${linuxLink} ${reason}`],
    });
  }
});

test('allows a newer successful attempt to replace an older failure of the same name', () => {
  const input = snapshot();
  input.run.attempt = 2;
  const success: Job = { ...input.jobs.find(job => job.name === linuxLink)!, id: 100, attempt: 2 };
  input.jobs = [success, ...input.jobs.map(job => job.name === linuxLink ? { ...job, conclusion: 'failure' } : job)];
  expect(verifyGroup(input)).toEqual({ state: 'pass', reasons: [] });
});

test('applies the same success requirement to CI jobs outside the expected list', () => {
  const input = snapshot();
  input.jobs = [...input.jobs, { ...input.jobs[0], id: 100, name: 'Extra CI job', conclusion: 'neutral' }];
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: ['merge group job Extra CI job concluded neutral'],
  });
});

test('fails an empty expected-job list', () => {
  expect(verifyGroup({ ...snapshot(), expectedJobs: [] }).state).toBe('fail');
});

test('waits for incomplete CI evidence even when every expected job is present', () => {
  const input = snapshot();
  input.run.complete = false;
  expect(verifyGroup(input).state).toBe('wait');
});

test.each([
  [`${releasePath}@dev`, 'queued'],
  [`${followOmniPath}@dev`, 'in_progress'],
])('waits when %s is %s', (path, status) => {
  const input = snapshot();
  input.release.runs = [...input.release.runs, {
    id: 21, path, status, conclusion: null, createdAt: '2026-11-19T14:00:00Z',
    releaseRan: path.startsWith(releasePath),
  }];
  expect(verifyGroup(input)).toEqual({ state: 'wait', reasons: [`${path} is ${status}`] });
});

test('fails a newer called Release after a green standalone invocation', () => {
  const input = snapshot();
  const called: ReleaseRun = {
    id: 19, path: `${followOmniPath}@dev`, status: 'completed', conclusion: 'failure',
    createdAt: '2026-11-19T14:00:00Z', releaseRan: true,
  };
  input.release.runs = [called, ...input.release.runs];
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: ['Release job evidence does not belong to newest run 19'],
  });
  input.release.newestId = called.id;
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: ['newest Release run 19 concluded failure'],
  });
});

test('ignores a newer completed Follow Omni run when it did not call Release', () => {
  const input = snapshot();
  input.release.runs = [...input.release.runs, {
    id: 21, path: followOmniPath, status: 'completed', conclusion: 'failure',
    createdAt: '2026-11-19T14:00:00Z', releaseRan: false,
  }];
  expect(verifyGroup(input)).toEqual({ state: 'pass', reasons: [] });
});

test('waits for incomplete release evidence or missing release job rows', () => {
  const input = snapshot();
  expect(verifyGroup({ ...input, release: { ...input.release, complete: false } }).state).toBe('wait');
  expect(verifyGroup({ ...input, release: { ...input.release, newestJobs: [] } }).state).toBe('wait');
});

test('fails when a job in the newest release failed even with a successful run conclusion', () => {
  const input = snapshot();
  input.release.newestJobs = [
    { name: 'cut', conclusion: 'success' }, { name: 'herdr lane', conclusion: 'failure' },
  ];
  expect(verifyGroup(input)).toEqual({
    state: 'fail', reasons: ['newest Release job herdr lane concluded failure'],
  });
});

test('waits with no known Release invocation', () => {
  const input = snapshot();
  input.release.runs = [];
  input.release.newestId = null;
  input.release.newestJobs = [];
  expect(verifyGroup(input)).toEqual({ state: 'wait', reasons: ['no newest Release run known'] });
});

test('waits when job rows are newer than the run header (Astra round 2)', () => {
  const input = snapshot();
  input.jobs = input.jobs.map(job => job.name === linuxLink ? { ...job, conclusion: 'cancelled' } : job);
  input.jobs = [...input.jobs, { id: 900, runId, headSha: groupSha, name: linuxLink, attempt: 2, status: 'completed', conclusion: 'success' }];
  expect(verifyGroup(input).state).toBe('wait');
});

test('waits when one job id appears under two names', () => {
  const input = snapshot();
  const mac = input.jobs.find(job => job.name === 'Pocket Link bridge (macos-latest)')!;
  const linux = input.jobs.find(job => job.name === linuxLink)!;
  mac.id = linux.id;
  expect(verifyGroup(input).state).toBe('wait');
});

test('a no-op Release after a failed genuine one does not hide the failure', () => {
  const input = snapshot();
  input.release.runs = [
    { id: 30, path: releasePath, status: 'completed', conclusion: 'failure', createdAt: '2026-11-19T13:00:00Z', releaseRan: true },
    { id: 31, path: releasePath, status: 'completed', conclusion: 'success', createdAt: '2026-11-19T14:00:00Z', releaseRan: false },
  ];
  input.release.newestId = 30;
  expect(verifyGroup(input).state).toBe('fail');
  input.release.newestId = 31;
  expect(verifyGroup(input).state).toBe('fail');
});

test('waits when a genuine release has no readable createdAt', () => {
  const input = snapshot();
  input.release.runs = [{ ...input.release.runs[0], createdAt: 'not a date' }];
  expect(verifyGroup(input).state).toBe('wait');
});

test('waits when a rerun has fewer rows of a name than an earlier attempt (Astra round 3)', () => {
  const input = snapshot();
  const linux = input.jobs.find(job => job.name === linuxLink)!;
  input.jobs = [
    ...input.jobs,
    { ...linux, id: 901, conclusion: 'cancelled' },
    { ...linux, id: 902, attempt: 2 },
  ];
  input.run = { ...input.run, attempt: 2 };
  expect(verifyGroup(input).state).toBe('wait');
});

test('a Release cancelled before its cut is the newest release and red', () => {
  const input = snapshot();
  input.release.runs = [
    { id: 40, path: releasePath, status: 'completed', conclusion: 'success', createdAt: '2026-11-19T13:00:00Z', releaseRan: true },
    { id: 41, path: releasePath, status: 'completed', conclusion: 'cancelled', createdAt: '2026-11-19T14:00:00Z', releaseRan: false },
  ];
  input.release.newestId = 40;
  expect(verifyGroup(input).state).toBe('fail');
});
