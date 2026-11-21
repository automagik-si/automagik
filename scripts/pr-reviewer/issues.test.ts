/** RFC 0029 D3a part 3: exercise issue drafting and closing drift on offline snapshots. */
import { expect, test } from 'bun:test';
import { closingDrift, draftIssue, repositoryPrivacy } from './issues';

const pr = { number: 1946, headSha: 'a'.repeat(40) };
const finding = { text: 'Handle the missing record.\nRetry the lookup.', path: 'src/records.ts', line: 17 };
const draft = { finding, pr, openIssues: [], searchComplete: true, privacy: repositoryPrivacy() };
const mergeCommit = 'b'.repeat(40);
const repo = 'automagik-dev/automagik';
const merged = { repo, mergeCommit, baseRef: 'dev', defaultBranch: 'dev', commitMessage: '' };
const appIssue = { state: 'open', openedByApp: true, resolvedByMerge: true } as const;

test('drafts an issue with its source, fingerprint, one label, and one PM message', () => {
  const result = draftIssue(draft);
  expect(result).toEqual({
    action: 'open',
    title: 'Review: Handle the missing record.',
    body: expect.stringMatching(/<!-- pr-reviewer:finding:[0-9a-f]{64} -->/),
    labels: ['from-review'],
    pmMessage: 'New issue from PR #1946 — Review: Handle the missing record.',
  });
  if (result.action !== 'open') throw new Error(`Expected an issue draft, got ${result.action}`);
  expect(result.body).toContain(`PR #1946 at \`${pr.headSha}\`, \`src/records.ts:17\`.`);
  expect(result.body).toContain(finding.text);
});

test('caps the prefixed title at 80 characters using the first line', () => {
  const result = draftIssue({
    ...draft, finding: { ...finding, text: 'A'.repeat(100) + '\r\nSecond line' },
  });
  expect(result).toMatchObject({ title: 'Review: ' + 'A'.repeat(72), body: expect.stringContaining('Second line') });
});

test('finds the marker across line moves, whitespace and case, and drafts a comment', () => {
  const original = draftIssue(draft);
  if (original.action !== 'open') throw new Error(`Expected an issue draft, got ${original.action}`);
  const nextPr = { number: 1950, headSha: 'c'.repeat(40) };
  const moved = { ...finding, text: '  HANDLE the missing record.  Retry the lookup.\n', line: 91 };
  const openIssues = [
    { number: 12, title: 'Review: Handle the missing record.', body: null },
    { number: 27, title: 'A renamed issue', body: original.body },
  ];
  const input = { ...draft, finding: moved, pr: nextPr, openIssues };
  expect(draftIssue(input)).toEqual({
    action: 'comment', issue: 27, body: `PR #1950 at \`${nextPr.headSha}\`, \`src/records.ts:91\`.`,
  });
  expect(draftIssue({ ...input, finding: { ...moved, path: 'src/other.ts' } }).action).toBe('open');
  expect(draftIssue({ ...input, finding: { ...moved, text: 'Skip the lookup.' } }).action).toBe('open');
});

test.each([
  'Review: Handle the missing record.',
  '  REVIEW:  Handle the missing   record.  ',
])('comments on an unmarked open issue with the exact normalized title (%s)', title => {
  const openIssues = [
    { number: 11, title: 'Review: Handle the missing record. and retry', body: null },
    { number: 12, title, body: 'Filed by a person.' },
  ];
  expect(draftIssue({ ...draft, openIssues })).toEqual({
    action: 'comment', issue: 12, body: `PR #1946 at \`${pr.headSha}\`, \`src/records.ts:17\`.`,
  });
});

test('waits when the issue search is incomplete', () => {
  const match = { number: 12, title: 'Review: Handle the missing record.', body: null };
  for (const openIssues of [[], [match]]) {
    expect(draftIssue({ ...draft, searchComplete: false, openIssues })).toEqual({ action: 'wait' });
  }
});

test('scans the rendered title, body, and PM message independently before drafting an issue', () => {
  const texts: string[] = [];
  const privacy = (text: string) => {
    texts.push(text);
    return text.startsWith('New issue') ? ['PM message problem'] : [];
  };
  expect(draftIssue({ ...draft, privacy })).toEqual({ action: 'held', problems: ['PM message problem'] });
  expect(texts).toEqual([
    'Review: Handle the missing record.',
    expect.stringContaining(finding.text),
    'New issue from PR #1946 — Review: Handle the missing record.',
  ]);
});

test('holds a synthetic private path in both a new issue and a duplicate comment', () => {
  const privatePath = ['', 'home', 'pr-reviewer-private-fixture', 'records.ts'].join('/');
  const open = draftIssue({ ...draft, finding: { ...finding, text: `Fix access to ${privatePath}` } });
  expect(open).toEqual({
    action: 'held', problems: ['home-path on line 1', 'home-path on line 5', 'home-path on line 1'],
  });

  const duplicate = draftIssue({
    ...draft, finding: { ...finding, path: privatePath },
    openIssues: [{ number: 12, title: 'Review: Handle the missing record.', body: null }],
  });
  expect(duplicate).toEqual({ action: 'held', problems: ['home-path on line 1'] });
});

test('reports closing drift in issue order and closes only resolved App issues', () => {
  const actions = closingDrift({
    ...merged,
    prBody: 'Refs #9, #8, #6 and #2\nCloses #5\nFixes #3\nFixes #2\nResolves #1',
    issues: [
      { ...appIssue, number: 9 },
      { ...appIssue, number: 8, state: 'closed' },
      { ...appIssue, number: 5, state: 'closed' },
      { ...appIssue, number: 3, resolvedByMerge: false },
      { ...appIssue, number: 2 },
      { ...appIssue, number: 1, openedByApp: false },
    ],
  });
  expect(actions).toEqual([
    { action: 'comment', issue: 1, comment: expect.stringContaining('Please confirm') },
    { action: 'close', issue: 2, comment: expect.stringContaining('resolved this issue') },
    { action: 'comment', issue: 3, comment: expect.stringContaining('Please confirm') },
    { action: 'unknown', issue: 6 },
    { action: 'comment', issue: 8, comment: expect.stringContaining('reopened') },
  ]);
  for (const action of actions) {
    if ('comment' in action) expect(action.comment).toContain(mergeCommit);
  }
});

test('a closing keyword claims only its immediately following issue', () => {
  expect(closingDrift({
    ...merged,
    prBody: 'Closes #5, #4\nFixes other/repo#6, #3',
    issues: [3, 4, 5].map(number => ({ ...appIssue, number })),
  })).toEqual([{ action: 'close', issue: 5, comment: expect.stringContaining(mergeCommit) }]);
});

test('a stacked-branch merge ignores closing keywords and still reports Refs drift', () => {
  expect(closingDrift({
    ...merged, baseRef: 'feature/base', prBody: 'Closes #5\nRefs #8',
    commitMessage: 'Fixes #4',
    issues: [{ ...appIssue, number: 5 }, { ...appIssue, number: 4 }, { ...appIssue, number: 8, state: 'closed' }],
  })).toEqual([{ action: 'comment', issue: 8, comment: expect.stringContaining(mergeCommit) }]);
});

test('does not report a Refs issue closed by a keyword in the landed commit as drift', () => {
  const input = { ...merged, prBody: 'Refs #8', commitMessage: 'Fixes #8' };
  expect(closingDrift({ ...input, issues: [{ ...appIssue, number: 8, state: 'closed' }] })).toEqual([]);
  expect(closingDrift({ ...input, issues: [{ ...appIssue, number: 8 }] })).toEqual([
    { action: 'close', issue: 8, comment: expect.stringContaining(mergeCommit) },
  ]);
});

test('holds a closing action if its rendered comment fails the privacy check', () => {
  const privacy = (text: string) => text.includes(mergeCommit) ? ['closing comment problem'] : [];
  expect(closingDrift({
    ...merged, prBody: 'Closes #5', issues: [{ ...appIssue, number: 5 }], privacy,
  })).toEqual([{ action: 'held', problems: ['closing comment problem'] }]);
});

test('ignores other repositories and fenced examples', () => {
  expect(closingDrift({
    ...merged,
    prBody: 'Fixes other/repo#5\nRefs other/repo#6\n\n```md\nCloses #7\nRefs #8\n```\n\nRefs ' + repo + '#9',
    commitMessage: 'Update examples\n\n```md\nFixes #10\n```',
    issues: [],
  })).toEqual([{ action: 'unknown', issue: 9 }]);
});

test('inline code between a keyword and an issue does not make a closing claim (Astra round 2)', () => {
  for (const field of ['prBody', 'commitMessage'] as const) {
    const input = { ...merged, prBody: 'Refs #9', commitMessage: '', [field]: 'Fixes `parser.ts` #8' };
    expect(closingDrift({ ...input, issues: [{ ...appIssue, number: 8 }, { ...appIssue, number: 9 }] })
      .filter(action => action.action === 'close')).toEqual([]);
  }
});

test('a code example wrapped across lines claims nothing', () => {
  const input = { ...merged, prBody: 'Example `wrapped\nFixes #8` here.', commitMessage: '' };
  expect(closingDrift({ ...input, issues: [{ ...appIssue, number: 8 }] }).filter(action => action.action === 'close'))
    .toEqual([]);
  expect(closingDrift({ ...merged, prBody: '```\nFixes #8\n```', commitMessage: '', issues: [{ ...appIssue, number: 8 }] })
    .filter(action => action.action === 'close')).toEqual([]);
  expect(closingDrift({ ...merged, prBody: 'Fixes #8', commitMessage: '', issues: [{ ...appIssue, number: 8 }] })
    .map(action => action.action)).toEqual(['close']);
});
