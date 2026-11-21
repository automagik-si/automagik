import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { compareLive, fill, validateTemplate } from './ruleset';

const templatePath = '.github/rulesets/dev-reviewed-merges.json';
const template: unknown = JSON.parse(readFileSync(new URL('../../' + templatePath, import.meta.url), 'utf8'));
const ids = { appId: 42, ownerId: 17, ownerType: 'Team' } as const;
const emptyReport = { differences: [], unverified: [] };
const teamMembership = 'bypass_actors.owner team membership';
const teamReport = { differences: [], unverified: [teamMembership] };

function changed(value: unknown, field: string, replacement: unknown) {
  const copy: unknown = structuredClone(value);
  const keys = field.replace(/\[(\d+)\]/g, '.$1').split('.');
  const key = keys.pop()!;
  let parent = copy as Record<string, unknown>;
  for (const segment of keys) parent = parent[segment] as Record<string, unknown>;
  parent[key] = replacement;
  return copy;
}

// What an editor's GET shows for the imported template: GitHub's own extra-approval switch, off.
function withSwitchOff<T>(live: T): T {
  return changed(live, 'rules[0].parameters.require_extra_approval_for_unattributed_changes', false) as T;
}

function activeRuleset() {
  return withSwitchOff({ ...fill(template, ids), enforcement: 'active' });
}

describe('the committed ruleset template', () => {
  test('passes validation', () => {
    expect(validateTemplate(template)).toEqual([]);
  });

  test.each([
    ['name', 'another ruleset'],
    ['target', 'tag'],
    ['conditions.ref_name.include', ['refs/heads/main']],
    ['conditions.ref_name.exclude', ['refs/heads/dev']],
    ['enforcement', 'active'],
    ['rules[0].parameters.required_approving_review_count', 0],
    ['rules[0].parameters.dismiss_stale_reviews_on_push', false],
    ['rules[0].parameters.require_last_push_approval', false],
    ['rules[0].parameters.require_code_owner_review', true],
    ['rules[0].parameters.required_review_thread_resolution', true],
    ['rules[0].parameters.allowed_merge_methods', ['squash', 'merge']],
    ['rules[1].parameters.required_status_checks[0].context', 'reviewer'],
    ['rules[1].parameters.required_status_checks[0].integration_id', 42],
    ['rules[1].parameters.required_status_checks[1].context', 'ci'],
    ['rules[1].parameters.required_status_checks[1].integration_id', 42],
    ['rules[1].parameters.strict_required_status_checks_policy', true],
    ['rules[1].parameters.do_not_enforce_on_create', true],
    ['rules[2].parameters.merge_method', 'MERGE'],
    ['rules[2].parameters.max_entries_to_build', 2],
    ['rules[2].parameters.max_entries_to_merge', 2],
    ['rules[2].parameters.min_entries_to_merge', 2],
    ['rules[2].parameters.min_entries_to_merge_wait_minutes', 1],
    ['rules[2].parameters.check_response_timeout_minutes', 60],
    ['rules[2].parameters.grouping_strategy', 'HEADGREEN'],
    ['bypass_actors[0].bypass_mode', 'pull_request'],
    ['bypass_actors[1].actor_id', 17],
    ['bypass_actors[1].actor_type', 'Team'],
  ] as [string, unknown][])('rejects a wrong value for %s', (field, value) => {
    const [problem] = validateTemplate(changed(template, field, value));
    expect(problem).toStartWith(field);
  });

  test('rejects a third bypass actor', () => {
    const actors = [...activeRuleset().bypass_actors, { actor_id: 18, actor_type: 'Team', bypass_mode: 'always' }];
    const [problem] = validateTemplate(changed(template, 'bypass_actors', actors));
    expect(problem).toStartWith('bypass_actors');
  });

  test('rejects unknown keys and names the missing field', () => {
    expect(validateTemplate(changed(template, 'extra', true))).toContain('extra is unknown');
    expect(validateTemplate(changed(template, 'rules[2].parameters.extra', true)))
      .toContain('rules[2].parameters.extra is unknown');
    const missing = changed(template, 'conditions.ref_name', { include: ['refs/heads/dev'] });
    expect(validateTemplate(missing)).toContain('conditions.ref_name.exclude is required');
  });
});

describe('fill', () => {
  test.each(['User', 'Team'] as const)('fills both App ID occurrences and the %s owner', (ownerType) => {
    const filled = fill(template, { ...ids, ownerType });
    expect(filled.enforcement).toBe('disabled');
    expect(filled.bypass_actors).toEqual([
      { actor_id: ids.appId, actor_type: 'Integration', bypass_mode: 'always' },
      { actor_id: ids.ownerId, actor_type: ownerType, bypass_mode: 'always' },
    ]);
    const checks = filled.rules.find(rule => rule.type === 'required_status_checks');
    expect(checks?.parameters.required_status_checks).toEqual([
      { context: 'pr-reviewer', integration_id: ids.appId },
      { context: 'CI result', integration_id: 15368 },
    ]);
    expect(JSON.stringify(filled)).not.toMatch(/@[A-Z_]+@/);
    expect(validateTemplate(template)).toEqual([]);
  });

  test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '42'])('rejects invalid IDs (%s)', (value) => {
    expect(() => fill(template, { ...ids, appId: value as number })).toThrow('appId');
    expect(() => fill(template, { ...ids, ownerId: value as number })).toThrow('ownerId');
  });

  test('rejects an invalid owner type', () => {
    expect(() => fill(template, { ...ids, ownerType: 'RepositoryRole' as 'Team' })).toThrow('ownerType');
  });

  test('refuses to print a template with an unresolved placeholder', () => {
    const field = 'rules[1].parameters.required_status_checks[0].integration_id';
    expect(() => fill(changed(template, field, '@OTHER_ID@'), ids)).toThrow(field);
  });
});

describe('compareLive', () => {
  test('rejects GitHub Actions as the reviewer App', () => {
    expect(() => compareLive(template, activeRuleset(), { ...ids, appId: 15368 })).toThrow('CI result integration ID');
  });

  test('matches the active ruleset regardless of rule, bypass actor and check order', () => {
    expect(compareLive(template, activeRuleset(), ids)).toEqual(teamReport);
    const live = activeRuleset();
    const reordered = {
      ...live,
      rules: live.rules.toReversed().map(rule => rule.type === 'required_status_checks' ? {
        ...rule,
        parameters: {
          ...rule.parameters,
          required_status_checks: rule.parameters.required_status_checks.toReversed(),
        },
      } : rule),
      bypass_actors: [...live.bypass_actors].reverse(),
    };
    expect(compareLive(template, reordered, ids)).toEqual(teamReport);
  });

  test('expects active unless told to expect disabled', () => {
    const disabled = withSwitchOff(fill(template, ids));
    expect(compareLive(template, disabled, ids).differences).toEqual(['enforcement must be "active"']);
    expect(compareLive(template, disabled, { ...ids, expect: 'disabled' })).toEqual(teamReport);
  });

  test('reports hidden bypass actors as unverified', () => {
    const { bypass_actors, ...live } = activeRuleset();
    expect(compareLive(template, live, ids)).toEqual({
      differences: [],
      unverified: [teamMembership, 'bypass_actors'],
    });
  });

  test('checks what it can when the actor IDs are visible but the owner ID and type are unspecified', () => {
    expect(compareLive(template, activeRuleset(), { appId: ids.appId })).toEqual({
      differences: [],
      unverified: [teamMembership, 'bypass_actors.owner.actor_id', 'bypass_actors.owner.actor_type'],
    });
    const wrongApp = changed(activeRuleset(), 'bypass_actors[0].actor_id', 43);
    expect(compareLive(template, wrongApp, { appId: ids.appId }).differences[0]).toStartWith('bypass_actors.app.actor_id');
  });

  test.each([
    ['Team', 'User'],
    ['User', 'Team'],
  ] as const)('reports team membership as unverified with an expected %s and a live %s', (ownerType, liveType) => {
    const live = changed(activeRuleset(), 'bypass_actors[1].actor_type', liveType);
    expect(compareLive(template, live, { ...ids, ownerType }).unverified).toEqual([teamMembership]);
  });

  test('verifies all fields with a User owner and both IDs supplied', () => {
    const owner = { ...ids, ownerType: 'User' } as const;
    const live = withSwitchOff({ ...fill(template, owner), enforcement: 'active' });
    expect(compareLive(template, live, owner)).toEqual(emptyReport);
  });

  test.each([
    ['name', 'renamed', 'name'],
    ['target', 'tag', 'target'],
    ['conditions.ref_name.include', ['refs/heads/main'], 'conditions.ref_name.include'],
    ['bypass_actors[1].actor_id', 18, 'bypass_actors.owner.actor_id'],
    ['bypass_actors[1].actor_type', 'User', 'bypass_actors.owner.actor_type'],
    ['bypass_actors[0].bypass_mode', 'pull_request', 'bypass_actors.app.bypass_mode'],
    ['rules[1].parameters.required_status_checks[1].integration_id', 42, 'rules.required_status_checks'],
    ['rules[2].parameters.max_entries_to_build', 2, 'rules.merge_queue.parameters.max_entries_to_build'],
  ] as const)('detects live drift in %s', (field, value, expectedField) => {
    const live = changed(activeRuleset(), field, value);
    expect(compareLive(template, live, ids).differences[0]).toStartWith(expectedField);
  });

  test('detects an added rule and a missing rule', () => {
    const live = activeRuleset();
    expect(compareLive(template, { ...live, rules: [...live.rules, { type: 'deletion' }] }, ids).differences)
      .toEqual(['rules.deletion is unexpected']);
    expect(compareLive(template, { ...live, rules: live.rules.slice(0, 2) }, ids).differences)
      .toEqual(['rules.merge_queue is required']);
  });

  test('ignores extra API metadata and neutral parameters on known rules', () => {
    const live = activeRuleset();
    const extra = changed(live, 'rules[0].parameters', {
      ...live.rules[0].parameters,
      required_reviewers: [],
      automatic_copilot_code_review_enabled: false,
      extra_null: null,
      extra_zero: 0,
      extra_string: '',
      extra_object: {},
    }) as typeof live;
    expect(compareLive(template, { ...extra, id: 83, source_type: 'Repository' }, ids)).toEqual(teamReport);
  });

  test.each([
    ['rules[0].parameters.required_reviewers', [{ reviewer: { id: 19, type: 'Team' }, minimum_approvals: 1 }],
      'rules.pull_request.parameters.required_reviewers'],
    ['rules[0].parameters.require_extra_approval_for_unattributed_changes', true,
      'rules.pull_request.parameters.require_extra_approval_for_unattributed_changes'],
    ['rules[1].parameters.extra', true, 'rules.required_status_checks.parameters.extra'],
    ['rules[2].parameters.extra', true, 'rules.merge_queue.parameters.extra'],
  ] as [string, unknown, string][])('detects a non-neutral extra parameter at %s', (field, value, expectedField) => {
    expect(compareLive(template, changed(activeRuleset(), field, value), ids).differences)
      .toEqual([expectedField + ' is unexpected']);
  });

  test('reports an absent extra-approval switch as unverified', () => {
    const live = activeRuleset();
    const { require_extra_approval_for_unattributed_changes, ...parameters } = live.rules[0].parameters as
      typeof live.rules[0]['parameters'] & { require_extra_approval_for_unattributed_changes: boolean };
    expect(compareLive(template, changed(live, 'rules[0].parameters', parameters), ids)).toEqual({
      differences: [],
      unverified: [teamMembership, 'rules.pull_request.parameters.require_extra_approval_for_unattributed_changes (must be off)'],
    });
  });

  test('treats a switched-off dismissal restriction as neutral and an enabled one as drift', () => {
    const off = changed(activeRuleset(), 'rules[0].parameters.dismissal_restriction', { enabled: false, allowed_actors: [] });
    expect(compareLive(template, off, ids)).toEqual(teamReport);
    const on = changed(activeRuleset(), 'rules[0].parameters.dismissal_restriction',
      { enabled: true, allowed_actors: [{ id: 7, type: 'Team' }] });
    expect(compareLive(template, on, ids).differences)
      .toEqual(['rules.pull_request.parameters.dismissal_restriction is unexpected']);
  });

  test('accepts disabled extra approval for unattributed changes', () => {
    const live = changed(activeRuleset(), 'rules[0].parameters.require_extra_approval_for_unattributed_changes', false);
    expect(compareLive(template, live, ids)).toEqual(teamReport);
  });

  test('accepts an absent do_not_enforce_on_create', () => {
    const live = activeRuleset();
    const checks = live.rules.find(rule => rule.type === 'required_status_checks')!;
    const { do_not_enforce_on_create, ...parameters } = checks.parameters;
    expect(compareLive(template, changed(live, 'rules[1].parameters', parameters), ids)).toEqual(teamReport);
  });

  test('detects an enabled do_not_enforce_on_create', () => {
    const live = changed(activeRuleset(), 'rules[1].parameters.do_not_enforce_on_create', true);
    expect(compareLive(template, live, ids).differences)
      .toEqual(['rules.required_status_checks.parameters.do_not_enforce_on_create must be false']);
  });
});

const cli = join(import.meta.dir, 'ruleset.ts');

test('fill exits nonzero with empty stdout for the GitHub Actions integration ID', () => {
  const result = spawnSync(process.execPath, [cli, 'fill', '--app-id', '15368', '--owner-id', '17', '--owner-type', 'User'], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('CI result integration ID');
});

function runDrift({ pages = [[{ id: 83, name: activeRuleset().name }]], detail = activeRuleset(), fail = '',
  args = ['--owner-id', '17', '--owner-type', 'Team'], appId = '42',
}: { pages?: unknown; detail?: unknown; fail?: string; args?: string[]; appId?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr-reviewer-ruleset-'));
  try {
    writeFileSync(join(dir, 'list.json'), JSON.stringify(pages));
    writeFileSync(join(dir, 'detail.json'), JSON.stringify(detail));
    writeFileSync(join(dir, 'calls'), '');
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\n' + [
      'printf "%s\\n" "$*" >> "$RULESET_STUB_DIR/calls"',
      'case "$*" in',
      '  "api --method GET --paginate --slurp repos/automagik-si/automagik/rulesets?includes_parents=false")',
      '    [ "$RULESET_STUB_FAIL" != list ] || exit 3',
      '    cat "$RULESET_STUB_DIR/list.json" ;;',
      '  "api --method GET repos/automagik-si/automagik/rulesets/83?includes_parents=false")',
      '    [ "$RULESET_STUB_FAIL" != detail ] || exit 3',
      '    cat "$RULESET_STUB_DIR/detail.json" ;;',
      '  *) exit 99 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o700 });
    const result = spawnSync(process.execPath, [cli, 'drift', '--app-id', appId, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir + delimiter + process.env.PATH,
        RULESET_STUB_DIR: dir,
        RULESET_STUB_FAIL: fail,
      },
    });
    return { ...result, calls: readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').filter(Boolean) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ruleset drift CLI', () => {
  test('rejects the GitHub Actions integration ID before requesting rulesets', () => {
    const result = runDrift({ appId: '15368' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CI result integration ID');
    expect(result.calls).toEqual([]);
  });

  test('exits 1 when the named ruleset is missing', () => {
    const result = runDrift({ pages: [[{ id: 1, name: 'Another ruleset' }]] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ruleset missing');
    expect(result.calls).toHaveLength(1);
  });

  test.each(['list', 'detail'])('exits 2 when the %s GET fails', (fail) => {
    const result = runDrift({ fail });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ruleset read failed');
  });

  test('exits 2 when the read succeeds with an invalid response shape', () => {
    const result = runDrift({ detail: null });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('expected a ruleset object');
  });

  test('exits 0 when the named ruleset on a later page matches', () => {
    const result = runDrift({ pages: [[{ id: 1, name: 'Another ruleset' }], [{ id: 83, name: activeRuleset().name }]] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('unverified: ' + teamMembership + '\n');
    expect(result.calls).toEqual([
      'api --method GET --paginate --slurp repos/automagik-si/automagik/rulesets?includes_parents=false',
      'api --method GET repos/automagik-si/automagik/rulesets/83?includes_parents=false',
    ]);
  });

  test('matches the repository ruleset when a parent has the same name', () => {
    const { name } = activeRuleset();
    const result = runDrift({ pages: [[
      { id: 82, name, source_type: 'Organization' },
      { id: 83, name, source_type: 'Repository' },
    ]] });
    expect(result.status).toBe(0);
    expect(result.calls[1]).toBe('api --method GET repos/automagik-si/automagik/rulesets/83?includes_parents=false');
  });

  test('exits 0 and prints fields it cannot verify', () => {
    const { bypass_actors, ...detail } = withSwitchOff(fill(template, ids));
    const result = runDrift({ detail, args: ['--expect', 'disabled'] });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('unverified: bypass_actors\n');
  });

  test('exits 1 when the live ruleset differs', () => {
    const result = runDrift({ detail: fill(template, ids) });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('difference: enforcement');
  });
});
