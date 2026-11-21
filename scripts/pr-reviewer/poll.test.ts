/** RFC 0029 D3a part 1: replay poll transitions and validate snapshot boundaries. */
import { describe, expect, test } from 'bun:test';
import { answer, apply, marker, reconcile, record, reduce as reducePoll, release, stillDue } from './poll';
import type { PollAction, PollState } from './poll';

const oldSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const devSha = 'c'.repeat(40);
const nextSha = 'd'.repeat(40);
const diffHash = 'diff-1';
const now = Date.parse('2026-11-20T12:00:00Z');

function reduce(state: PollState, snapshot: unknown, options = { now }) {
  return reducePoll(state, snapshot, options);
}
const empty: PollState = { cursor: '', pulls: {}, lastGeneration: 0 };
const pull = {
  number: 12, baseRef: 'dev', headSha, draft: false, author: 'writer',
  authorCanWrite: true, headRepoIsBase: true, labels: [],
  head: { sha: headSha, parents: [oldSha, devSha] },
  comments: [], commentsComplete: true,
  carry: { secondParentOnDev: true, diffHash, conflictResolved: false, ci: 'success' },
};
const snapshot = { complete: true, cursor: 'page-2', pulls: [pull], queue: [{ number: 12, headSha }] };
const unreviewedPull = {
  headSha, generation: 1, attempt: 1, draft: false, draftCycle: 0, draftShown: null,
  request: null, due: null, readyDue: null, replies: [], reviewedSha: null,
  verdict: null, diffHash: null, lastCommentId: 0, lastAnsweredId: 0,
};
const reviewed: PollState = {
  cursor: 'page-1',
  lastGeneration: 1,
  pulls: { 12: { ...unreviewedPull, headSha: oldSha, reviewedSha: oldSha, verdict: 'SHIP', diffHash, lastCommentId: 10 } },
};
function reviewAction({ number = 12, sha = headSha, generation = 1, attempt = 1, mode = 'run' }:
  { number?: number; sha?: string; generation?: number; attempt?: number; mode?: 'run' | 'read-only' } = {}) {
  return { kind: 'review', id: `review:${number}:${sha}:g${generation}:a${attempt}:${mode}`, number, sha, mode } as const;
}
const review = reviewAction();
const readOnlyReview = reviewAction({ mode: 'read-only' });
const nextReview = reviewAction({ generation: 2 });
const carry = { kind: 'carry', id: `carry:12:${oldSha}:${headSha}:g2`, number: 12, from: oldSha, to: headSha, diffHash } as const;

function statusAction(kind: 'draft' | 'ready', number: number, sha: string, generation: number, cycle: number) {
  return { kind, id: `${kind}:${number}:${sha}:g${generation}:a${cycle}`, number, sha };
}
const oldPull = { ...pull, headSha: oldSha, head: { sha: oldSha, parents: [devSha] } };

function comment(id: number, author = 'reader', association = 'NONE', canWrite: boolean | null = null) {
  return { id, author, association, canWrite, createdAt: '2026-11-20T12:00:00Z' };
}

function reply(commentId: number, trust: 'answer' | 'data' = 'data', number = 12) {
  return { kind: 'reply', id: `reply:${number}:c${commentId}`, number, sha: headSha, commentId, trust } as const;
}

function deliver(state: PollState, action: PollAction) {
  if (action.kind === 'reply' && action.trust === 'answer') {
    return answer(state, { number: action.number, commentId: action.commentId, changesFinding: false });
  }
  return apply(state, action);
}

describe('poll state and heads', () => {
  test('reviews a new PR and advances the cursor', () => {
    expect(reduce(empty, snapshot)).toEqual({
      actions: [review],
      state: {
        cursor: 'page-2',
        pulls: { 12: { ...unreviewedPull, due: { kind: 'review', id: review.id } } },
        observedAt: now,
        lastGeneration: 1,
      },
    });
  });

  test('retries an undelivered review, dedupes a requested review, and releases a failed run', () => {
    const { state, actions } = reduce(empty, snapshot);
    expect(reduce(JSON.parse(JSON.stringify(state)), snapshot).actions).toEqual([review]);

    const requested = apply(state, actions[0]);
    expect(requested.pulls[12].request).toEqual({ id: review.id, at: now });
    expect(reduce(requested, snapshot).actions).toEqual([]);

    const retry = reduce(release(requested, { number: 12, attemptId: review.id }), snapshot);
    const replacement = reviewAction({ attempt: 2 });
    expect(retry.actions).toEqual([replacement]);
    const running = apply(retry.state, retry.actions[0]);
    expect(() => release(running, { number: 12, attemptId: review.id })).toThrow('release.attemptId');
    const done = record(running, { number: 12, attemptId: replacement.id, verdict: 'FIX-FIRST', diffHash: null });
    expect(done.pulls[12]).toEqual({ ...unreviewedPull, attempt: 2, reviewedSha: headSha, verdict: 'FIX-FIRST' });
    expect(reduce(done, snapshot).actions).toEqual([]);
  });

  test('refuses the original A attempt when the head moves A to B and back to A', () => {
    const atA = { ...snapshot, pulls: [oldPull] };
    const first = reduce(empty, atA);
    const original = reviewAction({ sha: oldSha });
    expect(first.actions).toEqual([original]);
    const atB = reduce(apply(first.state, original), snapshot);
    expect(atB.actions).toEqual([nextReview]);
    const reset = reduce(atB.state, atA);
    const replacement = reviewAction({ sha: oldSha, generation: 3 });
    expect(reset.actions).toEqual([replacement]);

    expect(() => apply(reset.state, original)).toThrow('action.id');
    const running = apply(reset.state, replacement);
    const obsolete = { number: 12, attemptId: original.id, verdict: 'SHIP', diffHash };
    expect(() => release(running, { number: 12, attemptId: original.id })).toThrow('release.attemptId');
    expect(() => record(running, obsolete)).toThrow('review.attemptId');
    const finished = record(running, { ...obsolete, attemptId: replacement.id, verdict: 'FIX-FIRST' });
    expect(() => record(finished, obsolete)).toThrow('review.attemptId');
    expect(finished.pulls[12].verdict).toBe('FIX-FIRST');
  });

  for (const [transition, pulls] of [
    ['closes and reopens', []],
    ['retargets away from dev and back', [{ ...pull, baseRef: 'main' }]],
  ] as const) {
    test('refuses the old worker when a PR ' + transition + ' at the same head', () => {
      const initial = reduce(empty, snapshot);
      expect(initial.actions).toEqual([review]);
      const running = apply(initial.state, review);
      const removed = reduce(running, { ...snapshot, pulls, queue: [] });
      expect(removed.actions).toEqual([]);
      expect(removed.state.pulls).toEqual({});
      expect(removed.state.lastGeneration).toBe(1);

      const reopened = reduce(JSON.parse(JSON.stringify(removed.state)), snapshot);
      expect(reopened.actions).toEqual([nextReview]);
      expect(reopened.state.lastGeneration).toBe(2);
      const replacement = apply(reopened.state, nextReview);
      const obsolete = { number: 12, attemptId: review.id };
      expect(() => record(replacement, { ...obsolete, verdict: 'SHIP', diffHash })).toThrow('review.attemptId');
      expect(() => release(replacement, obsolete)).toThrow('release.attemptId');
    });
  }

  test('replaces an applied review whose worker dies once its request exceeds the timeout', () => {
    const offered = reduce(empty, snapshot);
    const running = apply(offered.state, review);
    const saved: PollState = JSON.parse(JSON.stringify(running));
    expect(reduce(saved, snapshot, { now: now + 90 * 60_000 }).actions).toEqual([]);
    const pastTimeout = now + 90 * 60_000 + 1;
    const retry = reduce(saved, snapshot, { now: pastTimeout });
    const replacement = reviewAction({ attempt: 2 });
    expect(retry.actions).toEqual([replacement]);
    expect(retry.state.pulls[12].request).toBeNull();
    expect(() => apply(retry.state, review)).toThrow('action.id');
    const restarted = apply(retry.state, replacement);
    expect(restarted.pulls[12].request).toEqual({ id: replacement.id, at: pastTimeout });
    expect(() => record(restarted, { number: 12, attemptId: review.id, verdict: 'SHIP', diffHash }))
      .toThrow('review.attemptId');
    expect(() => release(restarted, { number: 12, attemptId: review.id })).toThrow('release.attemptId');
    expect(reducePoll(saved, snapshot, { now: now + 60_001, reviewTimeoutMinutes: 1 }).actions).toEqual([replacement]);
  });

  test('reviews a new head and clears the old verdict while retaining the comment watermark', () => {
    const result = reduce(reviewed, { ...snapshot, pulls: [{ ...pull, head: { sha: headSha, parents: [oldSha] } }] });
    expect(result.actions).toEqual([nextReview]);
    expect(result.state.pulls[12]).toEqual({
      ...unreviewedPull, generation: 2, lastCommentId: 10, due: { kind: 'review', id: nextReview.id },
    });
  });

  test('shows draft once and restores a recorded verdict when the same head becomes ready', () => {
    const draftSnapshot = { ...snapshot, pulls: [{ ...oldPull, draft: true }] };
    const draft = statusAction('draft', 12, oldSha, 1, 1);
    const ready = statusAction('ready', 12, oldSha, 1, 2);
    const result = reduce(reviewed, draftSnapshot);
    expect(result.actions).toEqual([draft]);
    expect(result.state.pulls[12]).toMatchObject({ headSha: oldSha, draft: true, draftShown: null });
    expect(reduce(result.state, draftSnapshot).actions).toEqual([draft]);
    const shown = apply(result.state, draft);
    expect(shown.pulls[12].draftShown).toBe(oldSha);
    expect(reduce(shown, draftSnapshot).actions).toEqual([]);

    const readySnapshot = { ...snapshot, pulls: [oldPull] };
    const restored = reduce(shown, readySnapshot);
    expect(restored.actions).toEqual([ready]);
    expect(restored.state.pulls[12]).toMatchObject({
      draft: false, draftShown: oldSha, reviewedSha: oldSha, verdict: 'SHIP',
    });
    expect(reduce(restored.state, readySnapshot).actions).toEqual([ready]);
    const done = apply(restored.state, ready);
    expect(done.pulls[12].draftShown).toBeNull();
    expect(reduce(done, readySnapshot).actions).toEqual([]);
  });

  test('starts a review when an unreviewed draft at the same SHA becomes ready', () => {
    const result = reduce(empty, { ...snapshot, pulls: [{ ...pull, draft: true }] });
    expect(result.actions).toEqual([statusAction('draft', 12, headSha, 1, 0)]);
    const shown = apply(result.state, result.actions[0]);
    const ready = reduce(shown, snapshot);
    expect(ready.actions).toEqual([statusAction('ready', 12, headSha, 1, 1), review]);
    const applied = ready.actions.reduce(apply, ready.state);
    expect(applied.pulls[12].draftShown).toBeNull();
    expect(applied.pulls[12].request?.id).toBe(review.id);
  });

  test('voids a running review on entry to draft and requires a fresh review when ready', () => {
    const initial = reduce(empty, snapshot);
    const running = apply(initial.state, review);
    const draft = reduce(running, { ...snapshot, pulls: [{ ...pull, draft: true }] });
    expect(draft.actions).toEqual([statusAction('draft', 12, headSha, 1, 1)]);
    expect(draft.state.pulls[12].request).toBeNull();
    const late = { number: 12, attemptId: review.id, verdict: 'SHIP', diffHash };
    expect(() => record(draft.state, late)).toThrow('review.attemptId');

    const shown = apply(draft.state, draft.actions[0]);
    const ready = reduce(shown, snapshot);
    const replacement = reviewAction({ attempt: 2 });
    expect(ready.actions).toEqual([statusAction('ready', 12, headSha, 1, 2), replacement]);
    expect(ready.state.pulls[12]).toMatchObject({ reviewedSha: null, verdict: null });
    expect(() => record(ready.actions.reduce(apply, ready.state), late)).toThrow('review.attemptId');
  });

  test('reviews a new head when becoming ready after showing a draft at the previous head', () => {
    const draftSnapshot = { ...snapshot, pulls: [{ ...oldPull, draft: true }] };
    const result = reduce(reviewed, draftSnapshot);
    const shown = apply(result.state, result.actions[0]);
    expect(reduce(shown, snapshot).actions).toEqual([statusAction('ready', 12, headSha, 2, 2), nextReview]);
  });

  test('drops closed and retargeted PRs and ignores PRs that target another branch', () => {
    const state = { ...reviewed, pulls: { ...reviewed.pulls, 13: reviewed.pulls[12] } };
    const pulls = [{ ...pull, baseRef: 'main' }, { ...pull, number: 14, baseRef: 'release' }];
    expect(reduce(state, { ...snapshot, pulls })).toEqual({
      state: { cursor: 'page-2', pulls: {}, observedAt: now, lastGeneration: 1 }, actions: [],
    });
  });

  test('waits on an incomplete snapshot and keeps the state and cursor', () => {
    const result = reduce(reviewed, { ...snapshot, complete: false, pulls: [] });
    expect(result.state).toBe(reviewed);
    expect(result.actions).toEqual([{ kind: 'wait', id: 'wait:snapshot-incomplete', reason: 'snapshot incomplete' }]);
  });

  for (const [name, authorCanWrite, headRepoIsBase] of [
    ['same repository non-writer', false, true],
    ['outside fork', false, false],
    ['unknown write permission', null, true],
    ['writer fork', true, false],
    ['unknown head repository', true, null],
  ] as const) {
    test('reviews a ' + name + ' in read-only mode', () => {
      const pulls = [{ ...pull, authorCanWrite, headRepoIsBase }];
      expect(reduce(empty, { ...snapshot, pulls }).actions).toEqual([readOnlyReview]);
    });
  }

  test('voids a running review when write permission becomes unknown at the same head', () => {
    const initial = reduce(empty, snapshot);
    const running = apply(initial.state, review);
    const unknownAccess = { ...snapshot, pulls: [{ ...pull, authorCanWrite: null }] };
    const downgraded = reduce(running, unknownAccess);
    const replacement = reviewAction({ attempt: 2, mode: 'read-only' });
    expect(downgraded.actions).toEqual([replacement]);
    expect(downgraded.state.pulls[12].request).toBeNull();
    expect(() => apply(downgraded.state, review)).toThrow('action.id');

    const late = { number: 12, attemptId: review.id, verdict: 'SHIP', diffHash };
    expect(() => record(downgraded.state, late)).toThrow('review.attemptId');
    expect(() => record(apply(downgraded.state, replacement), late)).toThrow('review.attemptId');
  });

  test('refuses a stale review and a review for a PR that is no longer tracked', () => {
    const finished = { number: 12, attemptId: review.id, verdict: 'SHIP', diffHash };
    expect(() => record(reviewed, finished)).toThrow('review.attemptId');
    expect(() => record(empty, finished)).toThrow('review.number');
  });
});

describe('comments', () => {
  test('advances past outsiders only when there is no earlier reply due', () => {
    const comments = [
      comment(18, 'stranger', 'NEW_ASSOCIATION'), comment(16, 'owner', 'OWNER', true),
      comment(12, 'WRITER', 'NONE', true), comment(13, 'member', 'MEMBER'),
      comment(15, 'collaborator', 'COLLABORATOR', true), comment(11, 'contributor', 'CONTRIBUTOR'),
      comment(10, 'writer'), comment(9, 'owner', 'OWNER'),
    ];
    const page = { ...snapshot, pulls: [{ ...pull, comments }] };
    const result = reduce(reviewed, page);
    expect(result.actions).toEqual([carry, reply(12, 'answer'), reply(13), reply(15, 'answer'), reply(16, 'answer')]);
    expect(result.state.pulls[12].lastCommentId).toBe(11);
    expect(result.state.cursor).toBe(reviewed.cursor);

    const delivered = result.actions.reduce(deliver, result.state);
    expect(delivered.pulls[12].lastCommentId).toBe(16);
    expect(() => apply(delivered, reply(12, 'answer'))).toThrow('action.id');
    const done = reduce(delivered, page);
    expect(done.actions).toEqual([]);
    expect(done.state.pulls[12].lastCommentId).toBe(18);
    expect(done.state.cursor).toBe(page.cursor);
  });

  test('replays a truncated comment page without replying again to the completed PR', () => {
    const other = { ...pull, number: 13, comments: [comment(5, 'writer', 'NONE', true)] };
    const comments = [comment(11, 'writer'), comment(12, 'member', 'MEMBER', true)];
    const truncated = { ...snapshot, pulls: [{ ...pull, comments: comments.slice(0, 1), commentsComplete: false }, other] };
    const result = reduce(reviewed, truncated);
    expect(result.actions).toEqual([carry, reviewAction({ number: 13, generation: 3 }), reply(5, 'answer', 13)]);
    expect(result.state.cursor).toBe(reviewed.cursor);
    expect(result.state.pulls[12].lastCommentId).toBe(10);
    const delivered = result.actions.reduce(deliver, result.state);
    const stillTruncated = reduce(delivered, truncated);
    expect(stillTruncated.actions).toEqual([]);
    expect(stillTruncated.state.cursor).toBe(reviewed.cursor);

    const complete = { ...snapshot, pulls: [{ ...pull, comments }, other] };
    const restored = reduce(stillTruncated.state, complete);
    expect(restored.actions).toEqual([reply(11), reply(12, 'answer')]);
    expect(restored.state.cursor).toBe(reviewed.cursor);
    const done = reduce(restored.actions.reduce(deliver, restored.state), complete);
    expect(done.actions).toEqual([]);
    expect(done.state.cursor).toBe(snapshot.cursor);
    expect(done.state.pulls[12].lastCommentId).toBe(12);
    expect(done.state.pulls[13].lastCommentId).toBe(5);
  });

  test('treats a fork author and team members without confirmed write access as data', () => {
    const fork = {
      ...pull, author: 'outsider', authorCanWrite: false, headRepoIsBase: false,
      comments: [
        comment(1, 'outsider', 'CONTRIBUTOR', false), comment(2, 'member', 'MEMBER', false),
        comment(3, 'owner', 'OWNER'), comment(4, 'collaborator', 'COLLABORATOR', true),
        comment(5, 'other', 'CONTRIBUTOR', true),
      ],
    };
    expect(reduce(empty, { ...snapshot, pulls: [fork] }).actions).toEqual([
      readOnlyReview, reply(1), reply(2), reply(3), reply(4, 'answer'),
    ]);
  });

  test('atomically acknowledges a finding-changing answer and schedules one same-head review', () => {
    const initial = reduce(empty, snapshot);
    const original = record(apply(initial.state, review), {
      number: 12, attemptId: review.id, verdict: 'FIX-FIRST', diffHash,
    });
    const page = { ...snapshot, pulls: [{ ...pull, comments: [comment(1, 'writer', 'NONE', true)] }] };
    const change = reduce(original, page);
    expect(change.actions).toEqual([reply(1, 'answer')]);
    expect(() => apply(change.state, change.actions[0])).toThrow('requires answer');
    const assessment = { number: 12, commentId: 1, changesFinding: true };
    const replied = answer(change.state, assessment);
    expect(replied.pulls[12]).toMatchObject({
      generation: 2, lastCommentId: 1, lastAnsweredId: 1, reviewedSha: null, verdict: null, diffHash: null,
    });
    expect(replied.lastGeneration).toBe(2);
    expect(answer(replied, assessment)).toBe(replied);

    const retry = reduce(JSON.parse(JSON.stringify(replied)), page);
    expect(retry.actions).toEqual([nextReview]);
    const requested = apply(retry.state, retry.actions[0]);
    expect(reduce(answer(requested, assessment), page).actions).toEqual([]);
    const finished = record(requested, { number: 12, attemptId: nextReview.id, verdict: 'SHIP', diffHash });
    expect(answer(finished, assessment)).toBe(finished);
    expect(reduce(finished, page).actions).toEqual([]);
  });

  test('a finding-changing answer allocates a generation above those of other PRs', () => {
    const page = {
      ...snapshot,
      pulls: [{ ...pull, comments: [comment(1, 'writer', 'NONE', true)] }, { ...pull, number: 13 }],
    };
    const initial = reduce(empty, page);
    expect(initial.state.lastGeneration).toBe(2);
    expect(initial.state.pulls[13].generation).toBe(2);

    const updated = answer(initial.state, { number: 12, commentId: 1, changesFinding: true });
    expect(updated.lastGeneration).toBe(3);
    expect(updated.pulls[12].generation).toBe(3);
    expect(reduce(updated, page).actions).toEqual([
      reviewAction({ generation: 3 }), reviewAction({ number: 13, generation: 2 }),
    ]);
  });

  test('a finding-changing answer invalidates an active attempt and a data reply cannot invalidate it', () => {
    const page = { ...snapshot, pulls: [{ ...pull, comments: [
      comment(1, 'writer', 'NONE', false), comment(2, 'writer', 'NONE', true),
    ] }] };
    const initial = reduce(empty, page);
    const running = apply(initial.state, review);
    expect(() => answer(running, { number: 12, commentId: 1, changesFinding: true })).toThrow('answer.commentId');
    const data = apply(running, reply(1));
    expect(data.pulls[12]).toMatchObject({ generation: 1, lastCommentId: 1, lastAnsweredId: 0, request: { id: review.id } });
    const changed = answer(data, { number: 12, commentId: 2, changesFinding: true });
    expect(changed.pulls[12].request).toBeNull();
    expect(() => record(changed, { number: 12, attemptId: review.id, verdict: 'SHIP', diffHash }))
      .toThrow('review.attemptId');
    expect(reduce(changed, page).actions).toEqual([nextReview]);
  });
});

describe('carry-over', () => {
  test('carries SHIP to a green dev merge and can carry it through a subsequent merge', () => {
    const result = reduce(reviewed, snapshot);
    expect(result.actions).toEqual([carry]);
    expect(result.state.pulls[12]).toEqual({
      ...reviewed.pulls[12], headSha, generation: 2, due: { kind: 'carry', id: carry.id },
    });
    const delivered = apply(result.state, result.actions[0]);
    expect(delivered.pulls[12]).toEqual({ ...reviewed.pulls[12], headSha, generation: 2, reviewedSha: headSha });
    expect(reduce(delivered, snapshot).actions).toEqual([]);
    const next = { ...pull, headSha: nextSha, head: { sha: nextSha, parents: [headSha, devSha] } };
    expect(reduce(delivered, { ...snapshot, pulls: [next] }).actions).toEqual([
      { ...carry, id: `carry:12:${headSha}:${nextSha}:g3`, from: headSha, to: nextSha },
    ]);
  });

  test('replays an undelivered carry and reply after the observed state is saved', () => {
    const page = { ...snapshot, pulls: [{ ...pull, comments: [comment(11, 'writer', 'NONE', true)] }] };
    const result = reduce(reviewed, page);
    expect(result.actions).toEqual([carry, reply(11, 'answer')]);
    const saved: PollState = JSON.parse(JSON.stringify(result.state));
    const replay = reduce(saved, page);
    expect(replay.actions).toEqual(result.actions);
    const carryDelivered = apply(replay.state, replay.actions[0]);
    expect(reduce(carryDelivered, page).actions).toEqual([reply(11, 'answer')]);
    const allDelivered = deliver(carryDelivered, replay.actions[1]);
    expect(reduce(allDelivered, page).actions).toEqual([]);
  });

  test('reconciles a posted carry and reply when delivery succeeds before state is saved', () => {
    const page = { ...snapshot, pulls: [{ ...pull, comments: [comment(11, 'writer'), comment(12, 'writer', 'NONE', true)] }] };
    const result = reduce(reviewed, page);
    expect(result.actions).toEqual([carry, reply(11), reply(12, 'answer')]);
    const posts = result.actions.map(action => 'Posted body\n\n' + marker(action));
    expect(posts).toEqual([
      'Posted body\n\n<!-- pr-reviewer:' + carry.id + ' -->',
      'Posted body\n\n<!-- pr-reviewer:reply:12:c11 -->',
      'Posted body\n\n<!-- pr-reviewer:reply:12:c12 -->',
    ]);

    const saved: PollState = JSON.parse(JSON.stringify(result.state));
    const ids = posts.map(post => /<!-- pr-reviewer:(.+) -->/.exec(post)![1]);
    const postedIds = [ids[0], ids[1], { id: ids[2], changesFinding: false }];
    const restored = reconcile(saved, postedIds);
    expect(restored.pulls[12]).toMatchObject({ reviewedSha: headSha, verdict: 'SHIP', lastCommentId: 12, generation: 2 });
    expect(reconcile(restored, postedIds)).toEqual(restored);
    expect(reduce(restored, page).actions).toEqual([]);
    expect(reduce(restored, page).state.cursor).toBe(page.cursor);
  });

  test('keeps a marker-only trusted reply pending until its finding assessment is known', () => {
    const page = { ...snapshot, pulls: [{ ...oldPull, comments: [comment(11, 'writer', 'NONE', true)] }] };
    const pending = reduce(reviewed, page);
    const action = { ...reply(11, 'answer'), sha: oldSha };
    expect(pending.actions).toEqual([action]);
    const postedMarker = marker(action);
    expect(postedMarker).toBe('<!-- pr-reviewer:reply:12:c11 -->');
    const saved: PollState = JSON.parse(JSON.stringify(pending.state));
    const markerId = /<!-- pr-reviewer:(.+) -->/.exec(postedMarker)![1];
    const markerOnly = reconcile(saved, [markerId]);
    expect(markerOnly).toEqual(saved);
    expect(reduce(markerOnly, page).actions).toEqual([action]);

    const assessment = { number: 12, commentId: 11, changesFinding: true };
    const posted = [{ id: markerId, changesFinding: true }];
    const restored = reconcile(markerOnly, posted);
    expect(answer(markerOnly, assessment)).toEqual(restored);
    expect(restored.lastGeneration).toBe(2);
    expect(restored.pulls[12]).toMatchObject({
      generation: 2, lastCommentId: 11, lastAnsweredId: 11, verdict: null,
    });
    expect(reconcile(restored, posted)).toEqual(restored);
    expect(reduce(restored, page).actions).toEqual([reviewAction({ sha: oldSha, generation: 2 })]);
  });

  test('reviews pending CI at the observed head and refuses late work for the old SHA', () => {
    const pending = { ...pull, carry: { ...pull.carry, ci: 'pending' } };
    const result = reduce(reviewed, { ...snapshot, pulls: [pending] });
    expect(result.actions).toEqual([nextReview]);
    expect(result.state.pulls[12]).toEqual({
      ...unreviewedPull, generation: 2, lastCommentId: 10, due: { kind: 'review', id: nextReview.id },
    });
    const staleReview = reviewAction({ sha: oldSha });
    expect(() => record(result.state, { number: 12, attemptId: staleReview.id, verdict: 'SHIP', diffHash }))
      .toThrow('review.attemptId');
    expect(() => apply(result.state, staleReview)).toThrow('action.sha is stale');
    expect(() => apply(result.state, { ...carry, from: devSha, to: oldSha })).toThrow('action.to is stale');
    expect(() => release(result.state, { number: 12, attemptId: staleReview.id })).toThrow('release.attemptId');
    expect(reduce(result.state, snapshot).actions).toEqual([nextReview]);
    expect(reduce(result.state, { ...snapshot, pulls: [oldPull] }).actions)
      .toEqual([reviewAction({ sha: oldSha, generation: 3 })]);
  });

  test('rejects a delayed carry as soon as a review supersedes it and after FIX-FIRST is recorded', () => {
    const green = reduce(reviewed, snapshot);
    expect(green.actions).toEqual([carry]);
    expect(stillDue(green.state, carry)).toBe(true);
    const approvals: string[] = [];
    function publishApproval(state: PollState, action: typeof carry) {
      if (stillDue(state, action)) approvals.push(marker(action));
    }

    const pending = { ...pull, carry: { ...pull.carry, ci: 'pending' } };
    const superseded = reduce(green.state, { ...snapshot, pulls: [pending] });
    expect(superseded.actions).toEqual([nextReview]);
    publishApproval(superseded.state, carry);
    expect(approvals).toHaveLength(0);
    expect(() => apply(superseded.state, carry)).toThrow('action.id');
    expect(reconcile(superseded.state, [carry.id])).toEqual(superseded.state);

    const requested = apply(superseded.state, nextReview);
    const result = record(requested, { number: 12, attemptId: nextReview.id, verdict: 'FIX-FIRST', diffHash });
    publishApproval(result, carry);
    expect(approvals).toHaveLength(0);
    expect(() => apply(result, carry)).toThrow('action.id');
    expect(result.pulls[12].verdict).toBe('FIX-FIRST');
  });

  for (const [why, changes] of [
    ['CI failed', { carry: { ...pull.carry, ci: 'failure' } }],
    ['CI is unknown', { carry: { ...pull.carry, ci: null } }],
    ['the commit differs from the PR head', { head: { ...pull.head, sha: nextSha } }],
    ['there is one parent', { head: { ...pull.head, parents: [oldSha] } }],
    ['there are three parents', { head: { ...pull.head, parents: [oldSha, devSha, nextSha] } }],
    ['a rewritten head has the same diff and green CI', { head: { ...pull.head, parents: [devSha] } }],
    ['the reviewed head is the wrong parent', { head: { ...pull.head, parents: [devSha, oldSha] } }],
    ['the second parent is outside dev', { carry: { ...pull.carry, secondParentOnDev: false } }],
    ['the second parent is unverified', { carry: { ...pull.carry, secondParentOnDev: null } }],
    ['the diff changed', { carry: { ...pull.carry, diffHash: 'diff-2' } }],
    ['the diff hash is unknown', { carry: { ...pull.carry, diffHash: null } }],
    ['a conflict was resolved', { carry: { ...pull.carry, conflictResolved: true } }],
    ['conflict resolution is unknown', { carry: { ...pull.carry, conflictResolved: null } }],
    ['the diff changed and CI is pending', { carry: { ...pull.carry, diffHash: 'diff-2', ci: 'pending' } }],
  ] as const) {
    test('reviews when ' + why, () => {
      expect(reduce(reviewed, { ...snapshot, pulls: [{ ...pull, ...changes }] }).actions).toEqual([nextReview]);
    });
  }

  test('requires SHIP, a reviewed SHA and a stored diff hash', () => {
    for (const changes of [{ verdict: 'BLOCKED' }, { reviewedSha: null }, { diffHash: null }] as const) {
      const prior = { ...reviewed, pulls: { 12: { ...reviewed.pulls[12], ...changes } } };
      expect(reduce(prior, snapshot).actions).toEqual([nextReview]);
    }
  });
});

test('sorts actions by PR number and kind, with replies in ascending ID order', () => {
  const pulls = [
    { ...pull, number: 30, comments: [comment(5, 'writer'), comment(3, 'writer')] },
    { ...pull, number: 12, comments: [comment(12, 'writer')], carry: { ...pull.carry, ci: 'pending' } },
    { ...pull, number: 3, draft: true, comments: [comment(1, 'writer')] },
    { ...pull, number: 20 },
  ];
  expect(reduce(reviewed, { ...snapshot, pulls }).actions).toEqual([
    statusAction('draft', 3, headSha, 4, 0), reply(1, 'data', 3),
    reviewAction({ generation: 3 }), reply(12),
    reviewAction({ number: 20, generation: 5 }),
    reviewAction({ number: 30, generation: 2 }), reply(3, 'data', 30), reply(5, 'data', 30),
  ]);
  expect(reduce(reviewed, { ...snapshot, pulls: [...pulls].reverse() }).actions).toEqual([
    statusAction('draft', 3, headSha, 3, 0), reply(1, 'data', 3),
    reviewAction({ generation: 4 }), reply(12),
    reviewAction({ number: 20, generation: 2 }),
    reviewAction({ number: 30, generation: 5 }), reply(3, 'data', 30), reply(5, 'data', 30),
  ]);
});

test('reduce, apply and record leave their inputs intact and produce JSON state', () => {
  const comments = Object.freeze([Object.freeze(comment(13, 'writer')), Object.freeze(comment(11, 'writer'))]);
  const original = Object.freeze({ ...snapshot, pulls: Object.freeze([Object.freeze({ ...pull, comments })]) });
  const before = Object.freeze({ ...reviewed, pulls: Object.freeze({ 12: Object.freeze(reviewed.pulls[12]) }) });
  const result = reduce(before, original);
  expect(comments.map(({ id }) => id)).toEqual([13, 11]);
  expect(before.pulls[12].lastCommentId).toBe(10);
  expect(before.pulls[12].headSha).toBe(oldSha);
  const delivered = apply(result.state, Object.freeze(result.actions[0]));
  expect(result.state.pulls[12].reviewedSha).toBe(oldSha);
  expect(delivered.pulls[12].reviewedSha).toBe(headSha);
  const initial = reduce(empty, snapshot);
  const requested = apply(initial.state, review);
  const finished = Object.freeze({ number: 12, attemptId: review.id, verdict: 'SHIP', diffHash: 'diff-2' });
  const done = record(requested, finished);
  expect(requested.pulls[12].diffHash).toBeNull();
  expect(requested.pulls[12].request?.id).toBe(review.id);
  expect(done.pulls[12].diffHash).toBe(finished.diffHash);
  expect(JSON.parse(JSON.stringify(done))).toEqual(done);
});

describe('poll validation', () => {
  test('names invalid state, snapshot and options fields', () => {
    expect(() => reduce(empty, { ...snapshot, extra: true })).toThrow('snapshot.extra is unknown');
    expect(() => reduce(empty, { ...snapshot, cursor: null })).toThrow('snapshot.cursor');
    expect(() => reduce(empty, { ...snapshot, pulls: [pull, pull] })).toThrow('snapshot.pulls[1].number is a duplicate');
    expect(() => reduce(empty, { ...snapshot, queue: [{ number: 0, headSha }] })).toThrow('snapshot.queue[0].number');
    expect(() => reduce(empty, { ...snapshot, queue: [{ number: 12, headSha: 'abc' }] }))
      .toThrow('snapshot.queue[0].headSha');
    expect(() => reduce({ ...reviewed, pulls: { 12: { ...reviewed.pulls[12], lastCommentId: -1 } } }, snapshot))
      .toThrow('state.pulls.12.lastCommentId');
    expect(() => Reflect.apply(reducePoll, undefined, [empty, snapshot, { now, extra: true }])).toThrow('options.extra');
    expect(() => reducePoll(empty, snapshot, { now: NaN })).toThrow('options.now');
    expect(() => reducePoll(empty, snapshot, { now, reviewTimeoutMinutes: -1 })).toThrow('options.reviewTimeoutMinutes');
  });

  test('names malformed and missing nested fields', () => {
    const { carry, ...partialPull } = pull;
    for (const [changes, field] of [
      [{ headSha: 'bad' }, 'headSha'],
      [{ authorCanWrite: 'true' }, 'authorCanWrite'],
      [{ headRepoIsBase: 1 }, 'headRepoIsBase'],
      [{ labels: [0] }, 'labels[0]'],
      [{ head: { ...pull.head, parents: [null] } }, 'head.parents[0]'],
      [{ carry: { ...carry, ci: 'neutral' } }, 'carry.ci'],
      [{ carry: { ...carry, diffHash: ' ' } }, 'carry.diffHash'],
      [{ comments: [comment(0)] }, 'comments[0].id'],
      [{ comments: [{ ...comment(11), canWrite: 'true' }] }, 'comments[0].canWrite'],
      [{ comments: [comment(11), comment(11)] }, 'comments[1].id'],
      [{ comments: [{ ...comment(11), createdAt: '2026-02-30T12:00:00Z' }] }, 'comments[0].createdAt'],
      [{ commentsComplete: 1 }, 'commentsComplete'],
    ] as const) {
      expect(() => reduce(empty, { ...snapshot, pulls: [{ ...pull, ...changes }] }))
        .toThrow('snapshot.pulls[0].' + field);
    }
    expect(() => reduce(empty, { ...snapshot, pulls: [partialPull] })).toThrow('snapshot.pulls[0].carry is required');
  });

  test('validates finished reviews', () => {
    const result = { number: 12, attemptId: review.id, verdict: 'SHIP', diffHash };
    expect(() => record(reviewed, { ...result, attemptId: '' })).toThrow('review.attemptId');
    expect(() => record(reviewed, { ...result, verdict: 'APPROVE' })).toThrow('review.verdict');
    expect(() => record(reviewed, { ...result, diffHash: false })).toThrow('review.diffHash');
    expect(() => record(reviewed, { ...result, extra: true })).toThrow('review.extra');
  });
});
