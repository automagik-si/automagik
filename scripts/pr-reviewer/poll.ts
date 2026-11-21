/** RFC 0029 D3a part 1: reduce a poll snapshot into PR state and actions. */
import type { verdictLine } from './rules';

type VerdictKind = Parameters<typeof verdictLine>[0];

type DecisionKind = 'draft' | 'ready' | 'carry' | 'review';
type Decision = { kind: DecisionKind; id: string };
type Reply = { id: string; commentId: number; trust: 'answer' | 'data' };

type PullState = {
  headSha: string;
  generation: number;
  attempt: number;
  draft: boolean;
  draftCycle: number;
  draftShown: string | null;
  request: { id: string; at: number } | null;
  due: Decision | null;
  readyDue: Decision | null;
  replies: Reply[];
  reviewedSha: string | null;
  verdict: VerdictKind | null;
  diffHash: string | null;
  lastCommentId: number;
  lastAnsweredId: number;
};

// lastGeneration only grows, across PRs and removals: a PR closed and reopened, or retargeted away from dev and
// back, gets a fresh generation, so no attempt id from before can match again.
export type PollState = {
  cursor: string; pulls: Record<number, PullState>; observedAt?: number; lastGeneration?: number;
};
type ReviewMode = 'run' | 'read-only';
type PullAction = (
  | { kind: 'draft' | 'ready'; number: number; sha: string }
  | { kind: 'carry'; number: number; from: string; to: string; diffHash: string }
  | { kind: 'review'; number: number; sha: string; mode: ReviewMode }
  | ({ kind: 'reply'; number: number; sha: string } & Reply)
) & { id: string };
export type PollAction = PullAction | { kind: 'wait'; id: string; reason: string };
type PollOptions = { now: number; reviewTimeoutMinutes?: number };

const ACTION_ORDER = { draft: 0, ready: 1, carry: 2, review: 3, reply: 4 } as const;
const TEAM_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const CI_RESULTS = ['success', 'pending', 'failure'] as const;
const VERDICTS = ['SHIP', 'FIX-FIRST', 'BLOCKED'] as const;

function invalid(field: string, reason: string): never {
  throw new Error('poll: ' + field + ' ' + reason);
}

function object(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, keys: readonly string[], field: string, optional: readonly string[] = []) {
  const fields = object(value, field);
  for (const key of Object.keys(fields)) {
    if (!keys.includes(key) && !optional.includes(key)) invalid(field + '.' + key, 'is unknown');
  }
  for (const key of keys) {
    if (!Object.hasOwn(fields, key)) invalid(field + '.' + key, 'is required');
  }
  return fields;
}

function array<T>(value: unknown, field: string, read: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) invalid(field, 'must be an array');
  return Array.from(value, (entry, index) => read(entry, field + '[' + index + ']'));
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field, 'must be a string');
  return value;
}

function nonempty(value: unknown, field: string): string {
  const text = string(value, field);
  if (!text.trim()) invalid(field, 'must be a non-empty string');
  return text;
}

function sha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    invalid(field, 'must be a 40-character lowercase commit SHA');
  }
  return value;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field, 'must be a boolean');
  return value;
}

function integer(value: unknown, field: string, min = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    invalid(field, min === 0 ? 'must be a non-negative integer' : 'must be a positive integer');
  }
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[], field: string): T {
  const selected = options.find(option => option === value);
  if (selected === undefined) invalid(field, 'must be one of ' + options.join(', '));
  return selected;
}

function nullable<T>(value: unknown, field: string, read: (value: unknown, field: string) => T): T | null {
  return value === null ? null : read(value, field);
}

function timestamp(value: unknown, field: string): string {
  const text = string(value, field);
  const date = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(text);
  const midnight = date ? Date.parse(date[1] + 'T00:00:00Z') : NaN;
  if (!date || !Number.isFinite(Date.parse(text)) || !Number.isFinite(midnight) ||
    new Date(midnight).toISOString().slice(0, 10) !== date[1]) {
    invalid(field, 'must be a valid ISO timestamp with a time zone');
  }
  return text;
}

function readComment(value: unknown, field: string) {
  const comment = exactObject(value, ['id', 'author', 'association', 'createdAt', 'canWrite'], field);
  return {
    id: integer(comment.id, field + '.id'),
    author: nonempty(comment.author, field + '.author'),
    association: nonempty(comment.association, field + '.association'),
    createdAt: timestamp(comment.createdAt, field + '.createdAt'),
    canWrite: nullable(comment.canWrite, field + '.canWrite', flag),
  };
}

function readPull(value: unknown, field: string) {
  const pull = exactObject(value, [
    'number', 'baseRef', 'headSha', 'draft', 'author', 'authorCanWrite', 'headRepoIsBase', 'labels',
    'head', 'comments', 'commentsComplete', 'carry',
  ], field);
  const head = exactObject(pull.head, ['sha', 'parents'], field + '.head');
  const carry = exactObject(pull.carry, ['secondParentOnDev', 'diffHash', 'conflictResolved', 'ci'], field + '.carry');
  const comments = array(pull.comments, field + '.comments', readComment);
  const seen = new Set<number>();
  for (const [index, { id }] of comments.entries()) {
    if (seen.has(id)) invalid(field + '.comments[' + index + '].id', 'is a duplicate');
    seen.add(id);
  }
  return {
    number: integer(pull.number, field + '.number'),
    baseRef: nonempty(pull.baseRef, field + '.baseRef'),
    headSha: sha(pull.headSha, field + '.headSha'),
    draft: flag(pull.draft, field + '.draft'),
    author: nonempty(pull.author, field + '.author'),
    authorCanWrite: nullable(pull.authorCanWrite, field + '.authorCanWrite', flag),
    headRepoIsBase: nullable(pull.headRepoIsBase, field + '.headRepoIsBase', flag),
    labels: array(pull.labels, field + '.labels', nonempty),
    head: { sha: sha(head.sha, field + '.head.sha'), parents: array(head.parents, field + '.head.parents', sha) },
    comments,
    commentsComplete: flag(pull.commentsComplete, field + '.commentsComplete'),
    carry: {
      secondParentOnDev: nullable(carry.secondParentOnDev, field + '.carry.secondParentOnDev', flag),
      diffHash: nullable(carry.diffHash, field + '.carry.diffHash', nonempty),
      conflictResolved: nullable(carry.conflictResolved, field + '.carry.conflictResolved', flag),
      ci: carry.ci === null ? null : choice(carry.ci, CI_RESULTS, field + '.carry.ci'),
    },
  };
}

function readSnapshot(value: unknown) {
  const snapshot = exactObject(value, ['complete', 'cursor', 'pulls', 'queue'], 'snapshot');
  const complete = flag(snapshot.complete, 'snapshot.complete');
  const cursor = string(snapshot.cursor, 'snapshot.cursor');
  const pulls = array(snapshot.pulls, 'snapshot.pulls', readPull);
  const seen = new Set<number>();
  for (const [index, { number }] of pulls.entries()) {
    if (seen.has(number)) invalid('snapshot.pulls[' + index + '].number', 'is a duplicate');
    seen.add(number);
  }
  array(snapshot.queue, 'snapshot.queue', (value, field) => {
    const entry = exactObject(value, ['number', 'headSha'], field);
    integer(entry.number, field + '.number');
    sha(entry.headSha, field + '.headSha');
  });
  return { complete, cursor, pulls };
}

function readDecision(value: unknown, field: string): Decision {
  const due = exactObject(value, ['kind', 'id'], field);
  return {
    kind: choice(due.kind, ['draft', 'ready', 'carry', 'review'], field + '.kind'),
    id: nonempty(due.id, field + '.id'),
  };
}

function readRequest(value: unknown, field: string) {
  const request = exactObject(value, ['id', 'at'], field);
  return { id: nonempty(request.id, field + '.id'), at: integer(request.at, field + '.at', 0) };
}

function readReply(value: unknown, field: string): Reply {
  const reply = exactObject(value, ['id', 'commentId', 'trust'], field);
  return {
    id: nonempty(reply.id, field + '.id'),
    commentId: integer(reply.commentId, field + '.commentId'),
    trust: choice(reply.trust, ['answer', 'data'], field + '.trust'),
  };
}

function readState(value: unknown): PollState {
  const state = exactObject(value, ['cursor', 'pulls'], 'state', ['observedAt', 'lastGeneration']);
  const cursor = string(state.cursor, 'state.cursor');
  const pulls: PollState['pulls'] = {};
  for (const [key, value] of Object.entries(object(state.pulls, 'state.pulls'))) {
    const field = 'state.pulls.' + key;
    const number = integer(Number(key), field);
    if (String(number) !== key) invalid(field, 'must be keyed by PR number');
    const pull = exactObject(value, [
      'headSha', 'generation', 'attempt', 'draft', 'draftCycle', 'draftShown', 'request', 'due', 'readyDue',
      'replies', 'reviewedSha', 'verdict', 'diffHash', 'lastCommentId', 'lastAnsweredId',
    ], field);
    pulls[number] = {
      headSha: sha(pull.headSha, field + '.headSha'),
      generation: integer(pull.generation, field + '.generation'),
      attempt: integer(pull.attempt, field + '.attempt'),
      draft: flag(pull.draft, field + '.draft'),
      draftCycle: integer(pull.draftCycle, field + '.draftCycle', 0),
      draftShown: nullable(pull.draftShown, field + '.draftShown', sha),
      request: nullable(pull.request, field + '.request', readRequest),
      due: nullable(pull.due, field + '.due', readDecision),
      readyDue: nullable(pull.readyDue, field + '.readyDue', readDecision),
      replies: array(pull.replies, field + '.replies', readReply),
      reviewedSha: nullable(pull.reviewedSha, field + '.reviewedSha', sha),
      verdict: pull.verdict === null ? null : choice(pull.verdict, VERDICTS, field + '.verdict'),
      diffHash: nullable(pull.diffHash, field + '.diffHash', nonempty),
      lastCommentId: integer(pull.lastCommentId, field + '.lastCommentId', 0),
      lastAnsweredId: integer(pull.lastAnsweredId, field + '.lastAnsweredId', 0),
    };
  }
  const next: PollState = { cursor, pulls };
  if (Object.hasOwn(state, 'observedAt')) next.observedAt = integer(state.observedAt, 'state.observedAt', 0);
  const highest = Math.max(0, ...Object.values(pulls).map(pull => pull.generation));
  next.lastGeneration = Object.hasOwn(state, 'lastGeneration')
    ? integer(state.lastGeneration, 'state.lastGeneration', 0) : highest;
  if (next.lastGeneration < highest) invalid('state.lastGeneration', 'is below a PR generation');
  return next;
}

function allocateGeneration(state: PollState) {
  const generation = (state.lastGeneration ?? 0) + 1;
  state.lastGeneration = generation;
  return generation;
}

type Pull = ReturnType<typeof readPull>;

function carryFrom(pull: Pull, previous: PullState | undefined) {
  const { head, headSha, carry } = pull;
  if (previous?.verdict === 'SHIP' && previous.reviewedSha !== null &&
    previous.reviewedSha !== headSha && (previous.headSha !== headSha || !previous.request) &&
    (previous.headSha === headSha || previous.reviewedSha === previous.headSha) &&
    head.sha === headSha && head.parents.length === 2 && head.parents[0] === previous.reviewedSha &&
    carry.secondParentOnDev === true && carry.diffHash !== null && carry.diffHash === previous.diffHash &&
    carry.conflictResolved === false && carry.ci === 'success') {
    return { from: previous.reviewedSha, diffHash: carry.diffHash };
  }
}

/** now and request.at are Unix timestamps in milliseconds. */
export function reduce(state: PollState, snapshot: unknown, opts: PollOptions):
  { state: PollState; actions: PollAction[] } {
  const options = exactObject(opts, ['now'], 'options', ['reviewTimeoutMinutes']);
  const now = integer(options.now, 'options.now', 0);
  const timeout = options.reviewTimeoutMinutes === undefined
    ? 90 : integer(options.reviewTimeoutMinutes, 'options.reviewTimeoutMinutes', 0);
  const before = readState(state);
  const { complete, cursor, pulls } = readSnapshot(snapshot);
  if (!complete) return {
    state, actions: [{ kind: 'wait', id: 'wait:snapshot-incomplete', reason: 'snapshot incomplete' }],
  };

  const next: PollState = {
    cursor: pulls.every(pull => pull.commentsComplete) ? cursor : before.cursor,
    pulls: {},
    observedAt: now,
    lastGeneration: before.lastGeneration ?? 0,
  };
  const actions: PullAction[] = [];
  for (const pull of pulls) {
    if (pull.baseRef !== 'dev') continue;
    const { number, headSha, draft } = pull;
    const previous = before.pulls[number];
    const changed = previous?.headSha !== headSha;
    const draftShown = previous?.draftShown ?? null;
    const carry = draft || draftShown !== null ? undefined : carryFrom(pull, previous);
    // Keep the previous SHIP while its carry is due so an undelivered carry can be replayed.
    const priorReview = carry || (!changed && previous.reviewedSha === headSha) ? previous : undefined;
    const current: PullState = {
      headSha,
      generation: changed ? allocateGeneration(next) : previous.generation,
      attempt: changed ? 1 : previous.attempt,
      draft,
      draftCycle: (previous?.draftCycle ?? 0) + Number(!!previous && previous.draft !== draft),
      draftShown,
      request: changed ? null : previous.request,
      due: null,
      readyDue: null,
      replies: previous?.replies ?? [],
      reviewedSha: priorReview?.reviewedSha ?? null,
      verdict: priorReview?.verdict ?? null,
      diffHash: priorReview?.diffHash ?? null,
      lastCommentId: previous?.lastCommentId ?? 0,
      lastAnsweredId: previous?.lastAnsweredId ?? 0,
    };
    if (current.request && now - current.request.at > timeout * 60_000) {
      current.request = null;
      current.attempt++;
    }
    // A PR that turns draft voids its running review: a late result must not become the verdict.
    if (draft && current.request) {
      current.request = null;
      current.attempt++;
    }
    // A review dispatched to run code voids itself when the author's write access or the head repository no
    // longer confirms 'run' (RFC (b), Q5): the attempt id carries its mode.
    const mode: ReviewMode = pull.headRepoIsBase === true && pull.authorCanWrite === true ? 'run' : 'read-only';
    if (current.request && !current.request.id.endsWith(':' + mode)) {
      current.request = null;
      current.attempt++;
    }

    const headId = `${number}:${headSha}:g${current.generation}`;
    if (draft) {
      if (!changed && previous.due?.kind === 'review') current.attempt++;
      if (current.draftShown !== headSha) {
        const id = `draft:${headId}:a${current.draftCycle}`;
        current.due = { kind: 'draft', id };
        actions.push({ kind: 'draft', id, number, sha: headSha });
      }
    } else {
      if (current.draftShown !== null) {
        const id = `ready:${headId}:a${current.draftCycle}`;
        current.due = { kind: 'ready', id };
        actions.push({ kind: 'ready', id, number, sha: headSha });
      }
      if (carry) {
        const id = `carry:${number}:${carry.from}:${headSha}:g${current.generation}`;
        current.due = { kind: 'carry', id };
        actions.push({ kind: 'carry', id, number, to: headSha, ...carry });
      } else if (!current.request && current.reviewedSha !== headSha) {
        const id = `review:${headId}:a${current.attempt}:${mode}`;
        current.readyDue = current.due;
        current.due = { kind: 'review', id };
        actions.push({ kind: 'review', id, number, sha: headSha, mode });
      }
    }

    if (pull.commentsComplete) {
      current.replies = [];
      for (const comment of pull.comments.sort((a, b) => a.id - b.id)) {
        if (comment.id <= current.lastCommentId) continue;
        if (comment.author.toLowerCase() === pull.author.toLowerCase() ||
          TEAM_ASSOCIATIONS.has(comment.association)) {
          const trust = comment.canWrite === true ? 'answer' : 'data';
          const reply = { id: `reply:${number}:c${comment.id}`, commentId: comment.id, trust } as const;
          current.replies.push(reply);
          actions.push({ kind: 'reply', number, sha: headSha, ...reply });
        } else if (!current.replies.length) {
          current.lastCommentId = comment.id;
        }
      }
      if (current.replies.length) next.cursor = before.cursor;
    }
    next.pulls[number] = current;
  }

  actions.sort((a, b) => a.number - b.number || ACTION_ORDER[a.kind] - ACTION_ORDER[b.kind]);
  return { state: next, actions };
}

function trackedPull(state: PollState, number: unknown, field: string) {
  const pull = state.pulls[integer(number, field + '.number')];
  if (!pull) invalid(field + '.number', 'does not identify a tracked PR');
  return pull;
}

function applyDecision(state: PollState, pull: PullState, due: Decision) {
  switch (due.kind) {
    case 'review':
      pull.request = { id: due.id, at: integer(state.observedAt, 'state.observedAt', 0) };
      break;
    case 'carry':
      pull.reviewedSha = pull.headSha;
      pull.verdict = 'SHIP';
      break;
    case 'draft':
      pull.draftShown = pull.headSha;
      break;
    case 'ready':
      pull.draftShown = null;
      break;
  }
  if (pull.due?.id === due.id) {
    pull.due = pull.readyDue;
    pull.readyDue = null;
  } else {
    pull.readyDue = null;
  }
}

function acknowledgeReply(state: PollState, pull: PullState, reply: Reply, changesFinding: boolean) {
  pull.replies.shift();
  pull.lastCommentId = reply.commentId;
  if (changesFinding && reply.commentId > pull.lastAnsweredId) {
    pull.lastAnsweredId = reply.commentId;
    pull.generation = allocateGeneration(state);
    pull.attempt = 1;
    Object.assign(pull, {
      request: null, reviewedSha: null, verdict: null, diffHash: null, due: null, readyDue: null,
    });
  }
}

/** Acknowledge delivery after it succeeds. Deliver a PR's replies in ascending comment ID order. */
export function apply(state: PollState, action: PollAction): PollState {
  if (action.kind === 'wait') return state;
  const next = readState(state);
  const pull = trackedPull(next, action.number, 'action');
  const headField = action.kind === 'carry' ? 'to' : 'sha';
  const head = action.kind === 'carry' ? action.to : action.sha;
  if (head !== pull.headSha) invalid('action.' + headField, 'is stale for the current headSha');

  if (action.kind === 'reply') {
    const reply = pull.replies[0];
    if (!reply || reply.id !== action.id || reply.commentId !== action.commentId || reply.trust !== action.trust) {
      invalid('action.id', 'does not match the next due reply');
    }
    if (reply.trust === 'answer') invalid('action.kind', 'requires answer for a trusted reply');
    acknowledgeReply(next, pull, reply, false);
  } else {
    const due = [pull.due, pull.readyDue].find(due => due?.id === action.id && due.kind === action.kind);
    if (!due) invalid('action.id', 'does not match a current decision');
    applyDecision(next, pull, due);
  }
  return next;
}

export function answer(state: PollState, input: { number: number; commentId: number; changesFinding: boolean }): PollState {
  const next = readState(state);
  const result = exactObject(input, ['number', 'commentId', 'changesFinding'], 'answer');
  const pull = trackedPull(next, result.number, 'answer');
  const commentId = integer(result.commentId, 'answer.commentId');
  const changesFinding = flag(result.changesFinding, 'answer.changesFinding');
  if (commentId <= pull.lastCommentId) return state;
  const reply = pull.replies[0];
  if (!reply || reply.commentId !== commentId || reply.trust !== 'answer') {
    invalid('answer.commentId', 'does not match the next due trusted reply');
  }
  acknowledgeReply(next, pull, reply, changesFinding);
  return next;
}

function activeRequest(state: PollState, number: unknown, attempt: unknown, field: string) {
  const pull = trackedPull(state, number, field);
  const attemptId = nonempty(attempt, field + '.attemptId');
  if (pull.request?.id !== attemptId) invalid(field + '.attemptId', 'does not match the active request');
  return pull;
}

export function release(state: PollState, input: { number: number; attemptId: string }): PollState {
  const next = readState(state);
  const result = exactObject(input, ['number', 'attemptId'], 'release');
  const pull = activeRequest(next, result.number, result.attemptId, 'release');
  pull.request = null;
  pull.attempt++;
  return next;
}

export function record(state: PollState, review: unknown): PollState {
  const next = readState(state);
  const result = exactObject(review, ['number', 'attemptId', 'verdict', 'diffHash'], 'review');
  const verdict = choice(result.verdict, VERDICTS, 'review.verdict');
  const diffHash = nullable(result.diffHash, 'review.diffHash', nonempty);
  const pull = activeRequest(next, result.number, result.attemptId, 'review');
  Object.assign(pull, { reviewedSha: pull.headSha, request: null, verdict, diffHash });
  return next;
}

/** Ask right before delivering: an action superseded since it was emitted (a carry replaced by a review) is not posted. */
export function stillDue(state: PollState, action: PollAction): boolean {
  if (action.kind === 'wait') return false;
  const pull = readState(state).pulls[action.number];
  if (!pull) return false;
  const head = action.kind === 'carry' ? action.to : action.sha;
  if (head !== pull.headSha) return false;
  if (action.kind === 'reply') return pull.replies[0]?.id === action.id;
  return [pull.due, pull.readyDue].some(due => due?.id === action.id && due.kind === action.kind);
}

export function marker(action: PollAction): string {
  return `<!-- pr-reviewer:${action.id} -->`;
}

type PostedId = string | { id: string; changesFinding: boolean };

/**
 * Reconcile posts against the persisted due decisions. Replies are delivered in comment ID order.
 * Attach the persisted assessment to a posted trusted reply when it changes a finding.
 */
export function reconcile(state: PollState, postedIds: Iterable<PostedId>): PollState {
  const next = readState(state);
  const posted = new Map<string, boolean | undefined>(Array.from(postedIds, entry =>
    typeof entry === 'string' ? [entry, undefined] as const : [entry.id, entry.changesFinding] as const));
  for (const pull of Object.values(next.pulls)) {
    for (const due of [pull.readyDue, pull.due]) {
      if (due && posted.has(due.id)) applyDecision(next, pull, due);
    }
    while (pull.replies.length && posted.has(pull.replies[0].id)) {
      const reply = pull.replies[0];
      const assessment = posted.get(reply.id);
      // A trusted answer found only by its marker stays pending: whether it changed a finding is not known.
      if (reply.trust === 'answer' && assessment === undefined) break;
      acknowledgeReply(next, pull, reply, reply.trust === 'answer' && assessment === true);
    }
  }
  return next;
}
