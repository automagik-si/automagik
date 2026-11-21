/** RFC 0029 (c), (d), D5a: the disabled ruleset template and read-only drift check. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const APP_ID = '@APP_ID@';
const CI_RESULT_INTEGRATION_ID = 15368;
const OWNER_ID = '@OWNER_ACTOR_ID@';
const OWNER_TYPE = '@OWNER_ACTOR_TYPE@';
const NAME = 'dev: reviewed merges only';
const TEMPLATE_PATH = new URL('../../.github/rulesets/dev-reviewed-merges.json', import.meta.url);
const RULESETS = 'repos/automagik-si/automagik/rulesets';

type OwnerType = 'User' | 'Team';
type Enforcement = 'active' | 'disabled';
type FillOptions = { appId: number; ownerId: number; ownerType: OwnerType };
type CompareOptions = { appId: number; ownerId?: number; ownerType?: OwnerType; expect?: Enforcement };

function expectedRuleset<
  AppId extends number | typeof APP_ID,
  OwnerId extends number | typeof OWNER_ID,
  ActorType extends OwnerType | typeof OWNER_TYPE,
>(appId: AppId, ownerId: OwnerId, ownerType: ActorType) {
  return {
    name: NAME,
    target: 'branch',
    enforcement: 'disabled',
    conditions: { ref_name: { include: ['refs/heads/dev'], exclude: [] } },
    bypass_actors: [
      { actor_id: appId, actor_type: 'Integration', bypass_mode: 'always' },
      { actor_id: ownerId, actor_type: ownerType, bypass_mode: 'always' },
    ] as const,
    rules: [
      {
        type: 'pull_request' as const,
        parameters: {
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: true,
          require_code_owner_review: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ['squash'],
        },
      },
      {
        type: 'required_status_checks' as const,
        parameters: {
          strict_required_status_checks_policy: false,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: 'pr-reviewer', integration_id: appId },
            { context: 'CI result', integration_id: CI_RESULT_INTEGRATION_ID },
          ],
        },
      },
      {
        type: 'merge_queue' as const,
        parameters: {
          merge_method: 'SQUASH',
          max_entries_to_build: 1,
          max_entries_to_merge: 1,
          min_entries_to_merge: 1,
          min_entries_to_merge_wait_minutes: 0,
          grouping_strategy: 'ALLGREEN',
          check_response_timeout_minutes: 120,
        },
      },
    ],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requireAppId(appId: unknown) {
  if (!isId(appId)) throw new Error('appId must be a positive integer');
  if (appId === CI_RESULT_INTEGRATION_ID) throw new Error('appId must differ from the CI result integration ID');
}

function isNeutralParameter(value: unknown): boolean {
  return value === false || value === null || value === 0 || value === '' ||
    (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.keys(value).length === 0) ||
    // A switched-off restriction, such as pull_request's dismissal_restriction.
    (isObject(value) && value.enabled === false);
}

// GitHub turns this on by default for a new ruleset (a second approval on a PR it cannot
// attribute), and the template leaves it out; drift says so when the live ruleset does not show it.
const EXTRA_APPROVAL = 'require_extra_approval_for_unattributed_changes';

function isOwnerType(value: unknown): value is OwnerType {
  return value === 'User' || value === 'Team';
}

function compareValue(expected: unknown, actual: unknown, field: string, problems: string[], exact = true) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      problems.push(field + ' must be an array with ' + expected.length + ' entries');
      return;
    }
    for (const [index, entry] of expected.entries()) {
      compareValue(entry, actual[index], field + '[' + index + ']', problems, exact);
    }
  } else if (isObject(expected)) {
    if (!isObject(actual)) {
      problems.push((field || 'ruleset') + ' must be an object');
      return;
    }
    const child = (key: string) => field ? field + '.' + key : key;
    if (exact) {
      for (const key of Object.keys(actual)) {
        if (!Object.hasOwn(expected, key)) problems.push(child(key) + ' is unknown');
      }
    }
    for (const [key, value] of Object.entries(expected)) {
      if (Object.hasOwn(actual, key)) compareValue(value, actual[key], child(key), problems, exact);
      else problems.push(child(key) + ' is required');
    }
  } else if (expected !== actual) {
    problems.push(field + ' must be ' + JSON.stringify(expected));
  }
}

export function validateTemplate(value: unknown): string[] {
  const problems: string[] = [];
  compareValue(expectedRuleset(APP_ID, OWNER_ID, OWNER_TYPE), value, '', problems);
  return problems;
}

function requireTemplate(template: unknown) {
  const problems = validateTemplate(template);
  if (problems.length) throw new Error(problems.join('\n'));
}

export function fill(template: unknown, { appId, ownerId, ownerType }: FillOptions) {
  requireTemplate(template);
  requireAppId(appId);
  if (!isId(ownerId)) throw new Error('ownerId must be a positive integer');
  if (!isOwnerType(ownerType)) throw new Error('ownerType must be User or Team');
  const filled = expectedRuleset(appId, ownerId, ownerType);
  if (/@[A-Z_]+@/.test(JSON.stringify(filled))) throw new Error('an unfilled placeholder remains');
  return filled;
}

function compareChecks(expected: { context: string; integration_id: number }[], live: unknown, differences: string[]) {
  const field = 'rules.required_status_checks.parameters.required_status_checks';
  if (!Array.isArray(live)) {
    differences.push(field + ' must be an array');
    return;
  }
  const matches = (check: typeof expected[number], candidate: unknown) =>
    isObject(candidate) && check.context === candidate.context && check.integration_id === candidate.integration_id;
  for (const check of expected) {
    if (!live.some(candidate => matches(check, candidate))) {
      differences.push(field + ' is missing ' + JSON.stringify(check));
    }
  }
  for (const [index, candidate] of live.entries()) {
    if (!expected.some(check => matches(check, candidate))) {
      differences.push(field + '[' + index + '] is unexpected');
    }
  }
}

function compareRules(expected: ReturnType<typeof expectedRuleset<number, number, OwnerType>>['rules'],
  live: unknown, differences: string[], unverified: string[]) {
  if (!Array.isArray(live)) {
    differences.push('rules must be an array');
    return;
  }
  const byType = new Map<string, Record<string, unknown>>();
  for (const [index, rule] of live.entries()) {
    if (!isObject(rule) || typeof rule.type !== 'string') {
      differences.push('rules[' + index + '].type must be a string');
    } else if (!expected.some(({ type }) => type === rule.type)) {
      differences.push('rules.' + rule.type + ' is unexpected');
    } else if (byType.has(rule.type)) {
      differences.push('rules.' + rule.type + ' is duplicated');
    } else {
      byType.set(rule.type, rule);
    }
  }
  for (const rule of expected) {
    const actual = byType.get(rule.type);
    const field = 'rules.' + rule.type;
    if (!actual) {
      differences.push(field + ' is required');
      continue;
    }
    const parameterField = field + '.parameters';
    if (rule.type === 'required_status_checks' && isObject(actual.parameters)) {
      const { required_status_checks, ...parameters } = rule.parameters;
      const liveParameters = { do_not_enforce_on_create: false, ...actual.parameters };
      compareValue(parameters, liveParameters, parameterField, differences, false);
      compareChecks(required_status_checks, actual.parameters.required_status_checks, differences);
    } else {
      compareValue(rule.parameters, actual.parameters, parameterField, differences, false);
    }
    if (rule.type === 'pull_request' && isObject(actual.parameters) &&
      !Object.hasOwn(actual.parameters, EXTRA_APPROVAL)) {
      unverified.push(parameterField + '.' + EXTRA_APPROVAL + ' (must be off)');
    }
    if (isObject(actual.parameters)) {
      for (const [key, value] of Object.entries(actual.parameters)) {
        if (!Object.hasOwn(rule.parameters, key) && !isNeutralParameter(value)) {
          differences.push(parameterField + '.' + key + ' is unexpected');
        }
      }
    }
  }
}

export function compareLive(template: unknown, live: unknown, {
  appId, ownerId, ownerType, expect = 'active',
}: CompareOptions): { differences: string[]; unverified: string[] } {
  requireTemplate(template);
  requireAppId(appId);
  if (ownerId !== undefined && !isId(ownerId)) throw new Error('ownerId must be a positive integer');
  if (ownerType !== undefined && !isOwnerType(ownerType)) throw new Error('ownerType must be User or Team');

  const differences: string[] = [];
  const unverified: string[] = [];
  const actors = isObject(live) ? live.bypass_actors : undefined;
  const hasTeamActor = Array.isArray(actors) && actors.some(actor => isObject(actor) && actor.actor_type === 'Team');
  if (ownerType === 'Team' || hasTeamActor) {
    unverified.push('bypass_actors.owner team membership');
  }
  const expected = expectedRuleset(appId, ownerId ?? OWNER_ID, ownerType ?? OWNER_TYPE);
  if (!isObject(live)) return { differences: ['live ruleset must be an object'], unverified };
  compareValue(expected.name, live.name, 'name', differences);
  compareValue(expected.target, live.target, 'target', differences);
  compareValue(expect, live.enforcement, 'enforcement', differences);
  compareValue(expected.conditions, live.conditions, 'conditions', differences);
  compareRules(expected.rules, live.rules, differences, unverified);

  if (!Object.hasOwn(live, 'bypass_actors')) {
    unverified.push('bypass_actors');
  } else if (!Array.isArray(actors) || actors.length !== 2) {
    differences.push('bypass_actors must be an array with 2 entries');
  } else {
    const app = actors.find(actor => isObject(actor) && actor.actor_type === 'Integration');
    const owner = actors.find(actor => isObject(actor) && actor.actor_type !== 'Integration');
    compareValue(expected.bypass_actors[0], app, 'bypass_actors.app', differences);
    if (!isObject(owner)) {
      differences.push('bypass_actors.owner is required');
    } else {
      if (!isId(owner.actor_id)) differences.push('bypass_actors.owner.actor_id must be a positive integer');
      if (!isOwnerType(owner.actor_type)) differences.push('bypass_actors.owner.actor_type must be User or Team');
      compareValue({
        ...expected.bypass_actors[1],
        actor_id: ownerId ?? owner.actor_id,
        actor_type: ownerType ?? owner.actor_type,
      }, owner, 'bypass_actors.owner', differences);
      if (ownerId === undefined) unverified.push('bypass_actors.owner.actor_id');
      if (ownerType === undefined) unverified.push('bypass_actors.owner.actor_type');
    }
  }
  return { differences, unverified };
}

function readGitHub(endpoint: string, ...flags: string[]): unknown {
  const body = execFileSync('gh', ['api', '--method', 'GET', ...flags, endpoint], { encoding: 'utf8' });
  return JSON.parse(body);
}

function drift(template: unknown, options: CompareOptions): number {
  requireAppId(options.appId);
  let live: unknown;
  try {
    const pages = readGitHub(RULESETS + '?includes_parents=false', '--paginate', '--slurp');
    if (!Array.isArray(pages) || !pages.length || !pages.every(Array.isArray)) {
      throw new Error('expected an array of ruleset pages');
    }
    const entries: unknown[] = pages.flat();
    if (!entries.every(entry => isObject(entry) && typeof entry.name === 'string')) {
      throw new Error('each listed ruleset must have a name');
    }
    const matches = entries.filter(entry => isObject(entry) && entry.name === NAME &&
      (!Object.hasOwn(entry, 'source_type') || entry.source_type === 'Repository'));
    if (!matches.length) {
      console.error('ruleset missing: ' + NAME);
      return 1;
    }
    const [match] = matches;
    if (matches.length !== 1 || !isObject(match) || !isId(match.id)) {
      throw new Error('expected one ruleset named "' + NAME + '" with a positive integer id');
    }
    live = readGitHub(RULESETS + '/' + match.id + '?includes_parents=false');
    if (!isObject(live)) throw new Error('expected a ruleset object');
  } catch (error) {
    console.error('ruleset read failed: ' + (error instanceof Error ? error.message : error));
    return 2;
  }
  const { differences, unverified } = compareLive(template, live, options);
  for (const difference of differences) console.error('difference: ' + difference);
  for (const field of unverified) console.error('unverified: ' + field);
  return differences.length ? 1 : 0;
}

function parseId(value: string | undefined, flag: string): number {
  const id = Number(value);
  if (!value || !/^\d+$/.test(value) || !isId(id)) throw new Error(flag + ' must be a positive integer');
  return id;
}

function main([command, ...args]: string[]): number {
  if (command !== 'check' && command !== 'fill' && command !== 'drift') {
    throw new Error('usage: ruleset.ts check | fill --app-id N --owner-id M --owner-type User|Team | ' +
      'drift --app-id N [--owner-id M --owner-type User|Team] [--expect active|disabled]');
  }
  const template: unknown = JSON.parse(readFileSync(TEMPLATE_PATH, 'utf8'));
  requireTemplate(template);
  if (command === 'check') {
    parseArgs({ args });
    return 0;
  }

  const idFlags = {
    'app-id': { type: 'string' },
    'owner-id': { type: 'string' },
    'owner-type': { type: 'string' },
  } as const;
  const { values } = parseArgs({
    args,
    options: { ...idFlags, ...(command === 'drift' ? { expect: { type: 'string' as const } } : {}) },
  });
  const appId = parseId(values['app-id'], '--app-id');
  const ownerId = values['owner-id'] === undefined ? undefined : parseId(values['owner-id'], '--owner-id');
  const ownerType = values['owner-type'];
  const expect = values.expect ?? 'active';
  if (ownerType !== undefined && !isOwnerType(ownerType)) throw new Error('--owner-type must be User or Team');
  if (expect !== 'active' && expect !== 'disabled') throw new Error('--expect must be active or disabled');

  if (ownerId === undefined || ownerType === undefined) {
    if (command === 'fill' || ownerId !== undefined || ownerType !== undefined) {
      throw new Error('--owner-id and --owner-type are required together');
    }
    return drift(template, { appId, expect });
  }
  if (command === 'drift') return drift(template, { appId, ownerId, ownerType, expect });
  console.log(JSON.stringify(fill(template, { appId, ownerId, ownerType }), null, 2));
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
