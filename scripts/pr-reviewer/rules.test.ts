import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LABELS, changesFromFiles, classify, fromReviews, gate, loadRules, parseVerdictLine,
  unprotectedKeyFiles, validateRules, verdictLine,
} from './rules';
import type { CheckRun, Rules, Status } from './rules';

const root = join(import.meta.dir, '..', '..');
const rules = loadRules(join(root, '.github/pr-reviewer.json'));
const keyPath = 'plugin-lane/keys.json';
const keyPaths = [
  keyPath,
  'meter/usagemeter/meter-keys.json',
  'herdr/mods/am-sidebar/pack-keys.json',
  'am/am-keys.json',
  'am/meter-keys.json',
  'am/pack-keys.json',
  'am/plugin-lane-keys.json',
  'herdr/mods/am-sidebar/meter-keys.json',
  'herdr/install.sh',
  'apps/welcome-dsh/src/host/lane-keys.json',
  'apps/desktop/src/lane-keys.js',
  'apps/bots-dsh/src/host/role-keys.json',
];
const withoutKey: Rules = {
  ...rules,
  ownerReview: { ...rules.ownerReview, keys: rules.ownerReview.keys.filter(path => path !== keyPath) },
};

describe('the trusted rules file', () => {
  test('lists every tracked key and the token ledger exception', () => {
    const exceptions = rules.wordMatch.notBilling.map(({ path }) => path);
    expect(rules.ownerReview.keys).toEqual(keyPaths);
    expect(exceptions).toEqual(['meter/usagemeter/src/ledger.rs']);
    expect(LABELS).toEqual({ ownerReview: 'owner-review', fromReview: 'from-review' });

    const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0').filter(Boolean);
    for (const path of [...keyPaths, ...exceptions]) expect(paths).toContain(path);
    const files = paths.map(path => ({ path, content: readFileSync(join(root, path), 'utf8') }));
    expect(unprotectedKeyFiles(files, rules)).toEqual([]);
    const withoutKeys = { ...rules, ownerReview: { ...rules.ownerReview, keys: [] } };
    expect(unprotectedKeyFiles(files, withoutKeys)).toEqual([...keyPaths].sort());
    expect(unprotectedKeyFiles(files, withoutKey)).toEqual([keyPath]);
  });

  test('the key guard reads literal and escaped PEM and skips test fixtures', () => {
    const pem = '-----BEGIN PUBLIC KEY-----\nYWJj\nZA==\n-----END PUBLIC KEY-----';
    const files = [
      { path: 'docs/plain.pem', content: pem },
      { path: 'docs/escaped.json', content: JSON.stringify(pem) },
      { path: 'scripts/pr-reviewer/covered.ts', content: pem },
      { path: 'test/key.pem', content: pem },
      { path: 'lib/fixtures/key.pem', content: pem },
      { path: 'lib/key.test.ts', content: pem },
      { path: 'docs/header.txt', content: pem.split('\n')[0] + '\n' },
    ];
    expect(unprotectedKeyFiles(files, rules)).toEqual(['docs/escaped.json', 'docs/plain.pem']);
  });

  test('rejects unexpected fields, missing fields, duplicate strings and invalid values', () => {
    expect(() => validateRules({ ...rules, extra: true })).toThrow('pr-reviewer.json: extra');
    expect(() => validateRules({ ...rules, version: 2 })).toThrow('pr-reviewer.json: version');
    const ownerReview = { ...rules.ownerReview, keys: ['a', 'b', 'a'] };
    expect(() => validateRules({ ...rules, ownerReview })).toThrow('ownerReview.keys[2]');
    expect(() => validateRules({ ...rules, ownerReview: { ...ownerReview, extra: [] } }))
      .toThrow('ownerReview.extra');
    expect(() => validateRules({ ...rules, ownerReview: { ...ownerReview, billing: 'x' } }))
      .toThrow('ownerReview.billing');
    expect(() => validateRules({ ...rules, holdLabels: ['blocked', 'blocked'] }))
      .toThrow('holdLabels[1]');
    expect(() => validateRules({ ...rules, holdLabels: [' '] })).toThrow('holdLabels[0]');
    const wordMatch = { notBilling: [{ path: 'ledger.rs' }] };
    expect(() => validateRules({ ...rules, wordMatch })).toThrow('wordMatch.notBilling[0].why');
    expect(() => validateRules({ ...rules, wordMatch: { ...rules.wordMatch, words: ['Ledger'] } }))
      .toThrow('wordMatch.words');
  });
});

describe('changed files', () => {
  test('maps both sides of a rename and flags the GitHub file limit', () => {
    expect(changesFromFiles([
      { filename: 'docs/new.md', previous_filename: 'scripts/pr-reviewer/old.ts' },
      { filename: keyPath },
    ])).toEqual({
      changes: [{ path: 'docs/new.md', previousPath: 'scripts/pr-reviewer/old.ts' }, { path: keyPath }],
      complete: true,
    });
    const files = Array.from({ length: 3001 }, (_, index) => ({ filename: `docs/${index}.md` }));
    expect(changesFromFiles(files.slice(0, 2999)).complete).toBe(true);
    expect(changesFromFiles(files.slice(0, 3000)).complete).toBe(false);
    expect(changesFromFiles(files).changes).toHaveLength(3001);
    expect(changesFromFiles(files).complete).toBe(false);
  });

  test('protects deleted keys, release workflows, the policy, and either side of a rename', () => {
    const deleted = { filename: keyPath, status: 'removed' };
    const changes = changesFromFiles([
      deleted,
      { filename: '.github/workflows/release.yml' },
      { filename: '.github/pr-reviewer.json' },
      { filename: '.github/workflows/pr-reviewer-watch.yml' },
      { filename: '.github/workflows/follow-omni.yml' },
      { filename: 'docs/new.md', previous_filename: 'scripts/pr-reviewer/old.ts' },
      { filename: 'docs/new.md', previous_filename: 'scripts/pr-reviewer/old.ts' },
      { filename: 'scripts/pr-reviewer/new.ts', previous_filename: 'docs/old.md' },
    ]).changes;
    expect(classify(changes, rules)).toEqual({ ownerReview: [
      { path: '.github/pr-reviewer.json', group: 'reviewer' },
      { path: '.github/workflows/follow-omni.yml', group: 'release' },
      { path: '.github/workflows/pr-reviewer-watch.yml', group: 'reviewer' },
      { path: '.github/workflows/release.yml', group: 'release' },
      { path: keyPath, group: 'keys' },
      { path: 'scripts/pr-reviewer/new.ts', group: 'reviewer' },
      { path: 'scripts/pr-reviewer/old.ts', group: 'reviewer' },
    ], askOwner: [] });
  });

  test('matches whole words and plurals across camel case, acronyms and punctuation', () => {
    const changes = [
      'meter/usagemeter/src/ledger.rs', 'meter/usagemeter/src/ledger/tests.rs',
      'apps/bots-dsh/test/ledger.test.js', 'apps/x/StripeAdapter.ts', 'docs/grants-and-quotes.md',
      'apps/x/APIBillingLedger.ts', 'docs/LEDGERS-Grant.md', 'docs/ledgerlike-granted.md',
      'docs/x.md', 'docs/rebilling-payment-margin.md', 'docs/grant-grants.md',
    ].map(path => ({ path }));
    expect(classify(changes, rules)).toEqual({ ownerReview: [], askOwner: [
      { path: 'apps/bots-dsh/test/ledger.test.js', word: 'ledger' },
      { path: 'apps/x/APIBillingLedger.ts', word: 'billing' },
      { path: 'apps/x/APIBillingLedger.ts', word: 'ledger' },
      { path: 'docs/LEDGERS-Grant.md', word: 'grant' },
      { path: 'docs/LEDGERS-Grant.md', word: 'ledger' },
      { path: 'docs/grant-grants.md', word: 'grant' },
      { path: 'docs/grants-and-quotes.md', word: 'grant' },
      { path: 'meter/usagemeter/src/ledger/tests.rs', word: 'ledger' },
    ] });
  });

  test('listed paths name all their groups and an exception matches its literal path', () => {
    const path = 'scripts/pr-reviewer/billing-ledger.ts';
    const fixture = {
      ...rules,
      ownerReview: { ...rules.ownerReview, billing: [path, 'scripts/pr-reviewer/billing-*'] },
      wordMatch: { notBilling: [{ path: 'docs/ledger*.md', why: 'A literal path' }] },
    };
    expect(classify([{ path }, { path: 'docs/ledger.md' }, { path: 'docs/ledger*.md' }], fixture))
      .toEqual({ ownerReview: [{ path, group: 'billing' }, { path, group: 'reviewer' }],
        askOwner: [{ path: 'docs/ledger.md', word: 'ledger' }] });
  });
});

const headSha = 'abcdef01'.repeat(5);
const oldSha = '0'.repeat(40);
const ship = { kind: 'SHIP', sha: headSha } as const;
const reviewOptions = {
  headSha, owner: 'owner', author: 'author', appSlug: 'genie-app',
  writers: ['writer', 'author', 'genie-app[bot]', 'automagik-genie'],
};
const approval = (login: string) => ({
  user: { login, type: 'User' }, state: 'APPROVED', commit_id: headSha, body: null,
});
const appShip = {
  ...approval('genie-app[bot]'), user: { login: 'genie-app[bot]', type: 'Bot' },
  body: verdictLine('SHIP', headSha),
};

describe('head-bound verdicts and approvals', () => {
  test('round trips verdicts on the first line with LF or CRLF', () => {
    for (const kind of ['SHIP', 'FIX-FIRST', 'BLOCKED'] as const) {
      const line = verdictLine(kind, headSha);
      expect(line).toBe(`PR Reviewer: ${kind} at ${headSha}`);
      expect(parseVerdictLine(line)).toEqual({ kind, sha: headSha });
      expect(parseVerdictLine(`${line}\r\nReview details`)).toEqual({ kind, sha: headSha });
    }
  });

  test('rejects malformed verdict lines', () => {
    expect(() => verdictLine('SHIP', headSha.slice(0, 7))).toThrow();
    expect(() => verdictLine('SHIP', headSha.toUpperCase())).toThrow();
    expect(() => verdictLine('SHIP', `${headSha}\n`)).toThrow();
    for (const body of [
      `PR Reviewer: SHIP at ${headSha.slice(0, 7)}`,
      `PR Reviewer: SHIP at ${headSha.toUpperCase()}`,
      `PR Reviewer: UNKNOWN at ${headSha}`,
      `${appShip.body} trailing text`, `Review details\n${appShip.body}`,
    ]) expect(parseVerdictLine(body)).toBeNull();
  });

  test('requires the App bot identity, the head in both fields and the matching review state', () => {
    expect(fromReviews([appShip], reviewOptions).verdict).toEqual(ship);
    for (const review of [
      { ...appShip, commit_id: oldSha },
      { ...appShip, body: verdictLine('SHIP', oldSha) },
      { ...appShip, user: { ...appShip.user, type: 'User' } },
      { ...appShip, user: { login: 'another-app[bot]', type: 'Bot' } },
      { ...appShip, user: null },
      { ...appShip, state: 'CHANGES_REQUESTED' },
      { ...appShip, body: verdictLine('FIX-FIRST', headSha) },
    ]) expect(fromReviews([review], reviewOptions).verdict).toBeNull();
    for (const kind of ['FIX-FIRST', 'BLOCKED'] as const) {
      const review = { ...appShip, state: 'CHANGES_REQUESTED', body: verdictLine(kind, headSha) };
      expect(fromReviews([review], reviewOptions).verdict).toEqual({ kind, sha: headSha });
    }
  });

  test('only the latest substantive App review counts, in the supplied order', () => {
    for (const state of ['COMMENTED', 'PENDING']) {
      const review = { ...appShip, state };
      expect(fromReviews([review], reviewOptions).verdict).toBeNull();
      expect(fromReviews([appShip, review], reviewOptions).verdict).toEqual(ship);
    }
    for (const review of [
      { ...appShip, state: 'DISMISSED' },
      { ...appShip, commit_id: oldSha },
      { ...appShip, body: 'Approval without a verdict' },
    ]) {
      expect(fromReviews([
        { ...appShip, submitted_at: '2026-11-19T10:00:00Z' },
        { ...review, submitted_at: '2026-11-19T09:00:00Z' },
      ], reviewOptions).verdict).toBeNull();
    }
  });

  test('owner and writer approvals use their latest substantive review on the head', () => {
    const owner = approval('owner');
    const writer = approval('writer');
    expect(fromReviews([owner, writer], reviewOptions)).toEqual({
      verdict: null, ownerApprovedHead: true, teamApprovedHead: true,
    });
    expect(fromReviews([owner, { ...owner, state: 'COMMENTED' }], reviewOptions).ownerApprovedHead)
      .toBe(true);
    expect(fromReviews([owner, { ...owner, state: 'DISMISSED' }], reviewOptions).ownerApprovedHead)
      .toBe(false);
    expect(fromReviews([{ ...owner, commit_id: oldSha }], reviewOptions).ownerApprovedHead).toBe(false);
    expect(fromReviews([writer, { ...writer, state: 'CHANGES_REQUESTED' }], reviewOptions)
      .teamApprovedHead).toBe(false);
    expect(fromReviews([writer, { ...writer, commit_id: oldSha }], reviewOptions).teamApprovedHead)
      .toBe(false);
  });

  test('outside users, the author, the App and the machine user cannot supply team approval', () => {
    expect(fromReviews([
      approval('outsider'), approval('author'), appShip, approval('automagik-genie'),
    ], reviewOptions).teamApprovedHead).toBe(false);
    expect(fromReviews([approval('writer')], { ...reviewOptions, machineUser: 'writer' })
      .teamApprovedHead).toBe(false);
  });
});

const check: CheckRun = {
  id: 1, name: 'CI result', app: { id: 2 }, status: 'completed', conclusion: 'success',
};
const status: Status = { id: 1, context: 'legacy', state: 'success' };
const ready: Parameters<typeof gate>[0] = {
  headSha, base: 'dev', draft: false, labels: [], verdict: ship,
  results: { sha: headSha, checks: [check], statuses: [status] },
  complete: { results: true, reviews: true, files: true }, appId: 7,
  classification: classify([], rules),
  ownerApprovedHead: false, authorCanWrite: true, teamApprovedHead: false,
};
const failedCI = { ...ready.results, checks: [{ ...check, conclusion: 'failure' }] };

describe('the merge gate', () => {
  test('passes a ready PR and waits for a verdict on this head', () => {
    expect(gate(ready, rules)).toEqual({ state: 'pass', reasons: [] });
    for (const verdict of [null, { ...ship, sha: oldSha }]) {
      expect(gate({ ...ready, verdict }, rules)).toEqual({
        state: 'wait', reasons: ['no verdict at abcdef0'],
      });
    }
  });

  test('fails a negative verdict or a different base branch', () => {
    for (const kind of ['FIX-FIRST', 'BLOCKED'] as const) {
      expect(gate({ ...ready, verdict: { kind, sha: headSha } }, rules)).toEqual({
        state: 'fail', reasons: [`${kind} at abcdef0`],
      });
    }
    expect(gate({ ...ready, base: 'main' }, rules)).toEqual({
      state: 'fail', reasons: ['base main must be dev'],
    });
  });

  test('a draft waits and hold labels require action even after the owner approves', () => {
    expect(gate({ ...ready, draft: true }, rules)).toEqual({ state: 'wait', reasons: ['draft'] });
    const input = { ...ready, ownerApprovedHead: true, labels: ['blocked', 'do not merge'] };
    expect(gate(input, rules)).toEqual({
      state: 'action_required', reasons: ['hold label: do not merge', 'hold label: blocked'],
    });
  });

  test('requires a team approval for an author without write permission', () => {
    const outside = { ...ready, authorCanWrite: false };
    expect(gate(outside, rules)).toEqual({
      state: 'action_required', reasons: ['team approval required'],
    });
    expect(gate({ ...outside, teamApprovedHead: true }, rules)).toEqual({ state: 'pass', reasons: [] });
  });

  test('records every reason in order and gives drafts, actions and failures precedence', () => {
    const classification = classify([{ path: keyPath }], rules);
    const reasons = ['owner approval required for keys', 'check CI result concluded failure'];
    expect(gate({ ...ready, classification, results: failedCI }, rules)).toEqual({
      state: 'action_required', reasons,
    });
    expect(gate({ ...ready, draft: true, classification, results: failedCI }, rules)).toEqual({
      state: 'wait', reasons: ['draft', ...reasons],
    });
    expect(gate({ ...ready, verdict: null, results: failedCI }, rules)).toEqual({
      state: 'fail', reasons: ['no verdict at abcdef0', 'check CI result concluded failure'],
    });
  });

  test('waits for the results on this head and names each incomplete read', () => {
    expect(gate({ ...ready, results: { ...failedCI, sha: oldSha } }, rules)).toEqual({
      state: 'wait', reasons: ['results are for another head'],
    });
    const complete = { results: false, reviews: false, files: false };
    expect(gate({ ...ready, complete }, rules)).toEqual({
      state: 'wait',
      reasons: ['results not fully read', 'reviews not fully read', 'files not fully read'],
    });
    for (const part of ['results', 'reviews', 'files'] as const) {
      expect(gate({ ...ready, complete: { ...ready.complete, [part]: false } }, rules)).toEqual({
        state: 'wait', reasons: [`${part} not fully read`],
      });
    }
  });

  test('only a check with the App ID and pr-reviewer name is skipped', () => {
    const own = { ...check, name: 'pr-reviewer', app: { id: ready.appId }, conclusion: 'failure' };
    const results = { sha: headSha, checks: [own], statuses: [] };
    expect(gate({ ...ready, results }, rules)).toEqual({ state: 'pass', reasons: [] });
    for (const app of [check.app, null]) {
      expect(gate({ ...ready, results: { ...results, checks: [own, { ...own, app }] } }, rules))
        .toEqual({ state: 'fail', reasons: ['check pr-reviewer concluded failure'] });
    }
    const statuses = [{ ...status, context: 'pr-reviewer', state: 'failure' }];
    expect(gate({ ...ready, results: { ...results, statuses } }, rules)).toEqual({
      state: 'fail', reasons: ['status pr-reviewer is failure'],
    });
    const checks = [{ ...own, name: 'another check' }];
    expect(gate({ ...ready, results: { ...results, checks } }, rules))
      .toEqual({ state: 'fail', reasons: ['check another check concluded failure'] });
  });

  test('uses the highest check ID per App and name and status ID per case-folded context', () => {
    const checks = [{ ...check, id: 2 }, { ...check, conclusion: 'failure' }];
    const statuses = [{ ...status, id: 2 }, { ...status, context: 'LEGACY', state: 'failure' }];
    const results = { sha: headSha, checks, statuses };
    expect(gate({ ...ready, results }, rules)).toEqual({ state: 'pass', reasons: [] });
    const reruns = {
      ...results,
      checks: [...checks, { ...check, id: 3, status: 'in_progress', conclusion: null }],
      statuses: [...statuses, { id: 3, context: 'Legacy', state: 'pending' }],
    };
    expect(gate({ ...ready, results: reruns }, rules)).toEqual({
      state: 'wait', reasons: ['check CI result is in_progress', 'status Legacy is pending'],
    });
  });

  test('accepts green check conclusions and waits for unfinished checks', () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      const results = { ...ready.results, checks: [{ ...check, conclusion }] };
      expect(gate({ ...ready, results }, rules)).toEqual({ state: 'pass', reasons: [] });
    }
    const queued = { ...ready.results, checks: [{ ...check, status: 'queued', conclusion: null }] };
    expect(gate({ ...ready, results: queued }, rules)).toEqual({
      state: 'wait', reasons: ['check CI result is queued'],
    });
    for (const conclusion of ['cancelled', 'timed_out', null]) {
      const results = { ...ready.results, checks: [{ ...check, conclusion }] };
      expect(gate({ ...ready, results }, rules).state).toBe('fail');
    }
  });

  test('waits on pending legacy statuses and fails an error or unknown state', () => {
    for (const state of ['pending', 'error', 'unknown']) {
      const results = { ...ready.results, statuses: [{ ...status, state }] };
      expect(gate({ ...ready, results }, rules)).toEqual({
        state: state === 'pending' ? 'wait' : 'fail', reasons: [`status legacy is ${state}`],
      });
    }
  });
});

test('a green writer PR that changes a key waits for the owner on the head', () => {
  const { changes, complete } = changesFromFiles([{ filename: keyPath }]);
  const input = { ...ready, complete: { ...ready.complete, files: complete } };
  const evidence = fromReviews([appShip], reviewOptions);
  expect(gate({ ...input, ...evidence, classification: classify(changes, rules) }, rules)).toEqual({
    state: 'action_required', reasons: ['owner approval required for keys'],
  });
  expect(gate({ ...input, ...evidence, classification: classify(changes, withoutKey) }, withoutKey))
    .toEqual({ state: 'pass', reasons: [] });
  const approved = fromReviews([appShip, approval('owner')], reviewOptions);
  expect(gate({ ...input, ...approved, classification: classify(changes, rules) }, rules))
    .toEqual({ state: 'pass', reasons: [] });
});

test('a listed path and a word match each require an owner decision on a mixed PR', () => {
  const { changes } = changesFromFiles([{ filename: keyPath }, { filename: 'docs/grants.md' }]);
  const input = { ...ready, classification: classify(changes, rules) };
  expect(gate({ ...input, ...fromReviews([appShip], reviewOptions) }, rules)).toEqual({
    state: 'action_required',
    reasons: ['owner approval required for keys', 'owner ruling required for docs/grants.md (grant)'],
  });
  expect(gate({ ...input, ...fromReviews([appShip, approval('owner')], reviewOptions) }, rules))
    .toEqual({ state: 'pass', reasons: [] });
});
