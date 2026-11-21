/** RFC 0029 (k), D4a: decide whether the PR reviewer needs attention from an offline snapshot. */
import { readFileSync } from 'node:fs';
import { VERSION } from '../version';

const RELEASE = '.github/workflows/release.yml';
const FOLLOW_OMNI = '.github/workflows/follow-omni.yml';
const DEV = 'refs/heads/dev';
const PARTS = ['pulls', 'runs', 'pushes'] as const;
const WAITING_CHECKS = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];
const HOUR = 60 * 60 * 1000;

type WatchOptions = { now: string; appId: number; appLogin?: string };
export type WatchReport = {
  stuck: { number: number; headSha: string; reason: string }[];
  unexpectedPushes: { sha: string; reason: string }[];
  incomplete: string[];
  ok: boolean;
};

function invalid(field: string, reason: string): never {
  throw new Error(`watch: ${field} ${reason}`);
}

function exactObject(value: unknown, keys: readonly string[], field: string, optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) invalid(`${field}.${key}`, 'is unknown');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalid(`${field}.${key}`, 'is required');
  }
  return value as Record<string, unknown>;
}

function array<T>(value: unknown, field: string, read: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) invalid(field, 'must be an array');
  return Array.from(value, (entry, index) => read(entry, `${field}[${index}]`));
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(field, 'must be a non-empty string');
  return value;
}

function positiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    invalid(field, 'must be a positive integer');
  }
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean');
  return value;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    invalid(field, 'must be a 40-character lowercase commit SHA');
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  const date = typeof value === 'string' && value.match(
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/,
  );
  if (!date || typeof value !== 'string') invalid(field, 'must be a valid ISO timestamp with a time zone');
  const time = Date.parse(value);
  const midnight = Date.parse(`${date[1]}T00:00:00Z`);
  // Date.parse can roll an out-of-range day into the next month.
  if (!Number.isFinite(time) || !Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date[1]) {
    invalid(field, 'must be a valid ISO timestamp with a time zone');
  }
  return time;
}

function readCheck(value: unknown, field: string, appId: number) {
  const check = exactObject(value, ['id', 'name', 'appId', 'status', 'startedAt'], field);
  const id = positiveInt(check.id, `${field}.id`);
  if (typeof check.name !== 'string') invalid(`${field}.name`, 'must be a string');
  if (typeof check.appId !== 'number') invalid(`${field}.appId`, 'must be a number');
  if (typeof check.status !== 'string') invalid(`${field}.status`, 'must be a string');
  if (check.startedAt !== null && typeof check.startedAt !== 'string') {
    invalid(`${field}.startedAt`, 'must be a string or null');
  }
  if (check.name !== 'pr-reviewer' || check.appId !== appId) return null;
  return {
    id,
    status: check.status,
    startedAt: check.startedAt === null ? null : timestamp(check.startedAt, `${field}.startedAt`),
  };
}

function readPull(value: unknown, field: string, appId: number) {
  const pull = exactObject(value, ['number', 'draft', 'baseRef', 'headSha', 'checkRuns', 'complete'], field);
  return {
    number: positiveInt(pull.number, `${field}.number`),
    draft: flag(pull.draft, `${field}.draft`),
    baseRef: nonempty(pull.baseRef, `${field}.baseRef`),
    headSha: sha(pull.headSha, `${field}.headSha`),
    checkRuns: array(pull.checkRuns, `${field}.checkRuns`, (value, field) => readCheck(value, field, appId))
      .filter(check => check !== null),
    complete: flag(pull.complete, `${field}.complete`),
  };
}

function readPushed(value: unknown, field: string) {
  const { job, sha: pushedSha, attempt } = exactObject(value, ['job', 'sha', 'attempt'], field);
  if (job !== 'cut' && job !== 'list' && job !== 'carry') invalid(`${field}.job`, 'must be cut, list, or carry');
  return {
    job,
    sha: sha(pushedSha, `${field}.sha`),
    attempt: positiveInt(attempt, `${field}.attempt`),
  };
}

function readRun(value: unknown, field: string) {
  const run = exactObject(value, [
    'id', 'path', 'headBranch', 'headSha', 'status', 'createdAt', 'updatedAt', 'pushed', 'evidenceComplete',
  ], field);
  const createdAt = timestamp(run.createdAt, `${field}.createdAt`);
  const updatedAt = timestamp(run.updatedAt, `${field}.updatedAt`);
  if (updatedAt < createdAt) invalid(`${field}.updatedAt`, 'must be at or after createdAt');
  return {
    id: positiveInt(run.id, `${field}.id`),
    path: nonempty(run.path, `${field}.path`),
    headBranch: nonempty(run.headBranch, `${field}.headBranch`),
    headSha: sha(run.headSha, `${field}.headSha`),
    status: nonempty(run.status, `${field}.status`),
    createdAt,
    updatedAt,
    pushed: array(run.pushed, `${field}.pushed`, readPushed),
    evidenceComplete: flag(run.evidenceComplete, `${field}.evidenceComplete`),
  };
}

function readCommit(value: unknown, field: string) {
  const commit = exactObject(value, ['sha', 'parents', 'subject'], field);
  if (typeof commit.subject !== 'string') invalid(field + '.subject', 'must be a string');
  return {
    sha: sha(commit.sha, `${field}.sha`),
    parents: array(commit.parents, `${field}.parents`, sha),
    subject: commit.subject,
  };
}

function readPush(value: unknown, field: string) {
  const push = exactObject(value, [
    'actor', 'ref', 'before', 'after', 'activityType', 'timestamp', 'commits', 'commitsComplete',
  ], field);
  return {
    actor: push.actor === null ? null : nonempty(push.actor, `${field}.actor`),
    ref: nonempty(push.ref, `${field}.ref`),
    before: sha(push.before, `${field}.before`),
    after: sha(push.after, `${field}.after`),
    activityType: nonempty(push.activityType, `${field}.activityType`),
    timestamp: timestamp(push.timestamp, `${field}.timestamp`),
    commits: array(push.commits, `${field}.commits`, readCommit),
    commitsComplete: flag(push.commitsComplete, `${field}.commitsComplete`),
  };
}

function readSnapshot(value: unknown, appId: number) {
  const root = exactObject(value, [...PARTS, 'complete'], 'snapshot');
  const complete = exactObject(root.complete, PARTS, 'snapshot.complete');
  return {
    pulls: array(root.pulls, 'snapshot.pulls', (value, field) => readPull(value, field, appId)),
    runs: array(root.runs, 'snapshot.runs', readRun),
    pushes: array(root.pushes, 'snapshot.pushes', readPush),
    complete: {
      pulls: flag(complete.pulls, 'snapshot.complete.pulls'),
      runs: flag(complete.runs, 'snapshot.complete.runs'),
      pushes: flag(complete.pushes, 'snapshot.complete.pushes'),
    },
  };
}

type Push = ReturnType<typeof readPush>;

function waiting(status: string) {
  return WAITING_CHECKS.includes(status);
}

function pushJob(subject: string) {
  const cut = /^chore\(release\): v([0-9.]+)$/.exec(subject);
  if (cut && VERSION.test(cut[1])) return 'cut';
  const list = /^chore\(release\): list v([0-9.]+) in the market index$/.exec(subject);
  if (list && VERSION.test(list[1])) return 'list';
  if (/^chore\(desktop\): carry Omni \d+\.\d+\.\d+$/.test(subject)) return 'carry';
}

function pushShapeProblem(push: Push) {
  if (push.activityType !== 'push') return `dev activity is ${push.activityType}, expected a push`;
  if (push.commits.length !== 1) return 'push must contain exactly one new commit';
  const [commit] = push.commits;
  if (push.before === push.after || commit.sha !== push.after) return 'new commit does not match the pushed dev tip';
  if (commit.parents[0] !== push.before) return 'first parent does not match dev before the push';
}

function missingPushEvidenceReason(job: ReturnType<typeof pushJob>) {
  if (!job) return 'commit subject does not match a release cut, index listing, or Follow Omni bump';
  const source = job === 'carry' ? 'Follow Omni run' : 'Release or Follow Omni run';
  return `no ${source} recorded the pushed SHA for the ${job} job`;
}

export function watch(value: unknown, opts: WatchOptions): WatchReport {
  const options = exactObject(opts, ['now', 'appId'], 'options', ['appLogin']);
  const now = timestamp(options.now, 'options.now');
  const appId = positiveInt(options.appId, 'options.appId');
  const appLogin = Object.hasOwn(options, 'appLogin')
    ? nonempty(options.appLogin, 'options.appLogin')
    : 'automagik-genie[bot]';
  const { pulls, runs, pushes, complete } = readSnapshot(value, appId);

  const incomplete: string[] = PARTS.filter(part => !complete[part]);
  const stuck: WatchReport['stuck'] = [];
  const unexpectedPushes: WatchReport['unexpectedPushes'] = [];
  const releaseRuns = runs.filter(run => run.headBranch === 'dev' && [RELEASE, FOLLOW_OMNI].includes(run.path));
  const releaseWait = releaseRuns.some(run => waiting(run.status));
  // A run in a status the watch does not know may be a release wait: an overdue check is then not judged.
  const releaseUnknown = releaseRuns.some(run => run.status !== 'completed' && !waiting(run.status));

  if (complete.pulls) {
    for (const pull of pulls) {
      if (pull.draft || pull.baseRef !== 'dev') continue;
      const { number, headSha } = pull;
      if (!pull.complete) {
        incomplete.push(`PR #${number} check runs`);
        continue;
      }
      if (!pull.checkRuns.length) {
        stuck.push({ number, headSha, reason: 'no pr-reviewer check on the current head' });
        continue;
      }
      if (pull.checkRuns.some(check =>
        check.status !== 'completed' && (!WAITING_CHECKS.includes(check.status) || check.startedAt === null),
      )) {
        incomplete.push(`PR #${number} check status or start time`);
        continue;
      }
      const [newest, next] = pull.checkRuns.sort((a, b) => b.id - a.id);
      if (next?.id === newest.id) {
        incomplete.push(`PR #${number} check ${newest.id} observed twice`);
        continue;
      }
      const overdue = waiting(newest.status) && newest.startedAt !== null && now - newest.startedAt > HOUR;
      if (overdue && complete.runs && !releaseWait && releaseUnknown) {
        incomplete.push(`PR #${number} release wait unknown`);
      } else if (overdue && complete.runs && !releaseWait) {
        stuck.push({ number, headSha, reason: `pr-reviewer check has been ${newest.status} for over 60 minutes` });
      }
    }
  }

  if (complete.pushes) {
    const allEvidenceComplete = runs.every(run => run.evidenceComplete);
    for (const push of pushes) {
      if (push.ref !== DEV) continue;
      if (push.actor === null) {
        incomplete.push(`push ${push.after} actor`);
        continue;
      }
      if (push.actor !== appLogin) continue;
      if (!push.commitsComplete) {
        incomplete.push(`push ${push.after} commits`);
        continue;
      }
      if (!complete.runs) continue;
      const commit = push.commits.find(commit => commit.sha === push.after);
      const job = commit && pushJob(commit.subject);
      const recorded = job !== undefined && releaseRuns.some(run =>
        (job !== 'carry' || run.path === FOLLOW_OMNI) &&
        run.pushed.some(pushed => pushed.job === job && pushed.sha === push.after),
      );
      if (!recorded && !allEvidenceComplete) {
        incomplete.push(`push ${push.after} run evidence`);
        continue;
      }
      const reason = pushShapeProblem(push) ?? (recorded ? undefined : missingPushEvidenceReason(job));
      if (reason) unexpectedPushes.push({ sha: push.after, reason });
    }
  }

  return { stuck, unexpectedPushes, incomplete, ok: !stuck.length && !unexpectedPushes.length && !incomplete.length };
}

export function issueBody(report: WatchReport): string {
  if (report.ok) return '';
  const sections: string[] = [];
  if (report.stuck.length) {
    sections.push('### Stuck pull requests\n\n' + report.stuck
      .map(({ number, headSha, reason }) => `- #${number} at \`${headSha}\` — ${reason}`).join('\n'));
  }
  if (report.unexpectedPushes.length) {
    sections.push('### Unexpected App pushes to dev\n\n' + report.unexpectedPushes
      .map(({ sha, reason }) => `- \`${sha}\` — ${reason}`).join('\n'));
  }
  if (report.incomplete.length) {
    sections.push('### Incomplete snapshot\n\n' + report.incomplete.map(part => `- ${part}`).join('\n'));
  }
  return sections.join('\n\n');
}

function cli(args: string[]) {
  const [file, ...flags] = args;
  if (!file || file.startsWith('--')) {
    throw new Error('usage: bun scripts/pr-reviewer/watch.ts <snapshot.json> --now <iso> --app-id N');
  }
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const [key, value] = [flags[index], flags[index + 1]];
    if (key !== '--now' && key !== '--app-id') invalid(key, 'is unknown');
    if (options.has(key)) invalid(key, 'was given more than once');
    if (!value || value.startsWith('--')) invalid(key, 'requires a value');
    options.set(key, value);
  }
  const now = options.get('--now');
  const id = options.get('--app-id');
  if (now === undefined) invalid('--now', 'is required');
  if (id === undefined || !/^\d+$/.test(id)) invalid('--app-id', 'must be a positive integer');
  const report = watch(JSON.parse(readFileSync(file, 'utf8')), { now, appId: Number(id) });
  console.log(JSON.stringify(report, null, 2));
  return report.incomplete.length ? 2 : report.ok ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = cli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
