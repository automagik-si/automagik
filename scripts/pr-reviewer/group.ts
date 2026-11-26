/** RFC 0029 D3a part 3: verify a merge group against its PR head, CI attempts, and release evidence. */
import { gate, type Rules } from './rules';

const RELEASE_PATH = '.github/workflows/release.yml';
const FOLLOW_OMNI_PATH = '.github/workflows/follow-omni.yml';

type Head = { sha: string; state: ReturnType<typeof gate>['state'] };
type JobResult = { name: string; conclusion: string | null };
type GroupJob = JobResult & { id: number; runId: number; headSha: string; attempt: number; status: string };
type ReleaseRun = {
  id: number;
  path: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  releaseRan: boolean;
};
type GroupInput = {
  head: Head;
  queueEntry: { headSha: string; groupSha: string };
  run: { id: number; headSha: string; status: string; attempt: number; complete: boolean };
  // Includes every page of jobs from every attempt of the CI run.
  jobs: readonly GroupJob[];
  // Exact check-run names from the caller's trusted CI configuration.
  expectedJobs: readonly string[];
  release: {
    runs: readonly ReleaseRun[];
    newestId: number | null;
    newestJobs: readonly JobResult[];
    // Covers both the workflow runs and the selected invocation’s jobs.
    complete: boolean;
  };
};

type GroupResult = { state: 'pass' | 'wait' | 'fail'; reasons: string[] };

export function gateHead(snapshot: Parameters<typeof gate>[0], rules: Rules): Head {
  return { sha: snapshot.headSha, state: gate(snapshot, rules).state };
}

function newestJobsByName(jobs: readonly GroupJob[]): Map<string, GroupJob[]> {
  const newest = new Map<string, GroupJob[]>();
  for (const job of jobs) {
    const previous = newest.get(job.name);
    if (!previous || job.attempt > previous[0].attempt) newest.set(job.name, [job]);
    else if (job.attempt === previous[0].attempt) previous.push(job);
  }
  return newest;
}

function verifyRelease(release: GroupInput['release']): GroupResult {
  if (!release.complete) return { state: 'wait', reasons: ['Release evidence not fully read'] };

  let newest: ReleaseRun | undefined;
  for (const run of release.runs) {
    const path = run.path.split('@', 1)[0];
    if (path !== RELEASE_PATH && path !== FOLLOW_OMNI_PATH) continue;
    if (run.status !== 'completed') return { state: 'wait', reasons: [`${run.path} is ${run.status}`] };
    // No evidence: a Follow Omni run that called no Release (whatever its own result), and a Release whose cut did not
    // run and that still succeeded (an App push's no-op). A Release that failed or was cancelled before its cut counts:
    // it is the newest release, and red.
    if (!run.releaseRan && (path === FOLLOW_OMNI_PATH || run.conclusion === 'success')) continue;
    if (Number.isNaN(Date.parse(run.createdAt))) return { state: 'wait', reasons: [`${run.path} run ${run.id} has no readable createdAt`] };
    const byDate = newest ? Date.parse(run.createdAt) - Date.parse(newest.createdAt) : 0;
    if (!newest || byDate > 0 || (byDate === 0 && run.id > newest.id)) newest = run;
  }

  if (!newest) return { state: 'wait', reasons: ['no newest Release run known'] };
  if (release.newestId !== newest.id) {
    return { state: 'fail', reasons: [`Release job evidence does not belong to newest run ${newest.id}`] };
  }
  if (newest.conclusion !== 'success') {
    return { state: 'fail', reasons: [`newest Release run ${newest.id} concluded ${newest.conclusion ?? 'without a result'}`] };
  }
  if (!release.newestJobs.length) return { state: 'wait', reasons: ['no jobs known for newest Release run'] };

  const failures = release.newestJobs.filter(job => job.conclusion !== 'success' && job.conclusion !== 'skipped')
    .map(job => `newest Release job ${job.name} concluded ${job.conclusion ?? 'without a result'}`);
  return { state: failures.length ? 'fail' : 'pass', reasons: failures };
}

export function verifyGroup({ head, queueEntry, run, jobs, expectedJobs, release }: GroupInput): GroupResult {
  if (queueEntry.headSha !== head.sha) return { state: 'fail', reasons: ['merge group is for another PR head'] };
  if (run.headSha !== queueEntry.groupSha || jobs.some(job => job.runId !== run.id || job.headSha !== run.headSha)) {
    return { state: 'fail', reasons: ['CI evidence does not belong to the queued merge group and run'] };
  }
  if (head.state !== 'pass') {
    return {
      state: head.state === 'fail' ? 'fail' : 'wait',
      reasons: [`PR head gate is ${head.state}`],
    };
  }
  if (!run.complete) return { state: 'wait', reasons: [`CI run ${run.id} not fully read`] };
  if (run.status !== 'completed') return { state: 'wait', reasons: [`CI run ${run.id} is ${run.status}`] };
  if (!jobs.some(job => job.attempt === run.attempt)) {
    return { state: 'wait', reasons: [`no jobs known for CI run ${run.id} attempt ${run.attempt}`] };
  }
  if (jobs.some(job => job.attempt > run.attempt)) {
    return { state: 'wait', reasons: [`job rows are newer than CI run ${run.id} attempt ${run.attempt}`] };
  }
  const identities = new Map<number, string>();
  for (const job of jobs) {
    const identity = `${job.name}\n${job.attempt}`;
    if ((identities.get(job.id) ?? identity) !== identity) {
      return { state: 'wait', reasons: [`job ${job.id} appears under two names or attempts`] };
    }
    identities.set(job.id, identity);
  }
  if (!expectedJobs.length) return { state: 'fail', reasons: ['no expected merge group jobs specified'] };

  // A rerun that has fewer rows of a name than an earlier attempt: which same-name job it superseded is unknown.
  const rowsPerAttempt = new Map<string, Map<number, number>>();
  for (const job of jobs) {
    const counts = rowsPerAttempt.get(job.name) ?? new Map<number, number>();
    counts.set(job.attempt, (counts.get(job.attempt) ?? 0) + 1);
    rowsPerAttempt.set(job.name, counts);
  }
  for (const [name, counts] of rowsPerAttempt) {
    const newestAttempt = Math.max(...counts.keys());
    if (Math.max(...counts.values()) > counts.get(newestAttempt)!) {
      return { state: 'wait', reasons: [`rerun of ${name} does not show which earlier job it replaced`] };
    }
  }
  const newest = newestJobsByName(jobs);
  const failures = expectedJobs.filter(name => !newest.has(name))
    .map(name => `merge group is missing expected job ${name}`);
  for (const rows of newest.values()) {
    for (const job of rows) {
      if (job.status !== 'completed') failures.push(`merge group job ${job.name} is ${job.status}`);
      else if (job.conclusion !== 'success') {
        failures.push(`merge group job ${job.name} concluded ${job.conclusion ?? 'without a result'}`);
      }
    }
  }
  if (failures.length) return { state: 'fail', reasons: failures.sort() };

  return verifyRelease(release);
}
