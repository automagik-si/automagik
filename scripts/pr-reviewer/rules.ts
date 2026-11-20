/**
 * RFC 0029 (f), (g), (h) and its threat model: "merge conditions are code".
 * The caller loads this code and the rules file from the trusted base or deployed revision,
 * never from the PR's head. The billing list follows RFC 0025's Decided 3 as paths land,
 * including schemas, migrations, webhooks and prices.
 */
import { readFileSync } from 'node:fs';

export const LABELS = { ownerReview: 'owner-review', fromReview: 'from-review' } as const;
const WORDS = ['billing', 'ledger', 'grant'] as const;
const OWNER_GROUPS = ['billing', 'keys', 'release', 'reviewer'] as const;
type Word = typeof WORDS[number];
type OwnerGroup = typeof OWNER_GROUPS[number];

export type Rules = {
  version: 1;
  ownerReview: Record<OwnerGroup, string[]>;
  wordMatch: { notBilling: { path: string; why: string }[] };
  holdLabels: string[];
};

function invalid(field: string, reason: string): never {
  throw new Error(`pr-reviewer.json: ${field ? `${field} ` : ''}${reason}`);
}

function exactObject(value: unknown, keys: readonly string[], field = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, 'expected an object');
  }
  const child = (key: string) => field ? `${field}.${key}` : key;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(child(key), 'is unknown');
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalid(child(key), 'is required');
  }
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(field, 'must be a non-empty string');
  return value;
}

function uniqueStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) invalid(field, 'must be an array');
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const item = `${field}[${index}]`;
    const text = nonempty(entry, item);
    if (seen.has(text)) invalid(item, 'is a duplicate');
    seen.add(text);
  }
  return [...seen];
}

export function validateRules(value: unknown): Rules {
  const root = exactObject(value, ['version', 'ownerReview', 'wordMatch', 'holdLabels']);
  if (root.version !== 1) invalid('version', 'must be 1');
  const groups = exactObject(root.ownerReview, OWNER_GROUPS, 'ownerReview');
  const wordMatch = exactObject(root.wordMatch, ['notBilling'], 'wordMatch');
  if (!Array.isArray(wordMatch.notBilling)) invalid('wordMatch.notBilling', 'must be an array');
  return {
    version: 1,
    ownerReview: {
      billing: uniqueStrings(groups.billing, 'ownerReview.billing'),
      reviewer: uniqueStrings(groups.reviewer, 'ownerReview.reviewer'),
      release: uniqueStrings(groups.release, 'ownerReview.release'),
      keys: uniqueStrings(groups.keys, 'ownerReview.keys'),
    },
    wordMatch: {
      notBilling: Array.from(wordMatch.notBilling, (value, index) => {
        const field = `wordMatch.notBilling[${index}]`;
        const entry = exactObject(value, ['path', 'why'], field);
        return { path: nonempty(entry.path, `${field}.path`), why: nonempty(entry.why, `${field}.why`) };
      }),
    },
    holdLabels: uniqueStrings(root.holdLabels, 'holdLabels'),
  };
}

export function loadRules(file: string): Rules {
  return validateRules(JSON.parse(readFileSync(file, 'utf8')));
}

type Change = { path: string; previousPath?: string };
type ChangedFile = { filename: string; previous_filename?: string };

export function changesFromFiles(files: readonly ChangedFile[]) {
  const changes: Change[] = files.map(({ filename, previous_filename }) => {
    if (previous_filename === undefined) return { path: filename };
    return { path: filename, previousPath: previous_filename };
  });
  return { changes, complete: files.length < 3000 };
}

function ownerPatterns(rules: Rules) {
  return OWNER_GROUPS.map(group => ({
    group,
    globs: rules.ownerReview[group].map(pattern => new Bun.Glob(pattern)),
  }));
}

export function classify(changes: readonly Change[], rules: Rules) {
  const paths = new Set<string>();
  for (const { path, previousPath } of changes) {
    paths.add(path);
    if (previousPath !== undefined) paths.add(previousPath);
  }
  const patterns = ownerPatterns(rules);
  const notBilling = new Set(rules.wordMatch.notBilling.map(entry => entry.path));
  const ownerReview: { path: string; group: OwnerGroup }[] = [];
  const askOwner: { path: string; word: Word }[] = [];
  for (const path of [...paths].sort()) {
    const matching = patterns.filter(({ globs }) => globs.some(glob => glob.match(path)));
    for (const { group } of matching) ownerReview.push({ path, group });
    if (matching.length || notBilling.has(path)) continue;
    const tokens = path.split(/[^A-Za-z0-9]+/)
      .flatMap(token => token.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
      .map(token => token.toLowerCase());
    const words = WORDS.filter(word => tokens.includes(word) || tokens.includes(`${word}s`));
    for (const word of words.sort()) askOwner.push({ path, word });
  }
  return { ownerReview, askOwner };
}

const PUBLIC_KEY = new RegExp(
  String.raw`-----BEGIN PUBLIC KEY-----(?:\\r\\n|\\n|\r?\n)` +
  String.raw`(?:[A-Za-z0-9+/=]+(?:\\r\\n|\\n|\r?\n))+-----END PUBLIC KEY-----`,
);

export function unprotectedKeyFiles(files: readonly { path: string; content: string }[], rules: Rules) {
  const globs = ownerPatterns(rules).flatMap(({ globs }) => globs);
  const paths = new Set<string>();
  for (const { path, content } of files) {
    if (/(^|\/)(test|fixtures)\//.test(path) || /\.test\.[^/]+$/.test(path)) continue;
    if (PUBLIC_KEY.test(content) && !globs.some(glob => glob.match(path))) paths.add(path);
  }
  return [...paths].sort();
}

type VerdictKind = 'SHIP' | 'FIX-FIRST' | 'BLOCKED';
type Verdict = { kind: VerdictKind; sha: string };

export function verdictLine(kind: VerdictKind, sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Expected a 40-character lowercase commit SHA');
  return `PR Reviewer: ${kind} at ${sha}`;
}

export function parseVerdictLine(body: string): Verdict | null {
  const firstLine = body.split('\n', 1)[0].replace(/\r$/, '');
  const match = /^PR Reviewer: (SHIP|FIX-FIRST|BLOCKED) at ([0-9a-f]{40})$/.exec(firstLine);
  return match ? { kind: match[1] as VerdictKind, sha: match[2] } : null;
}

type Review = {
  user: { login: string; type: string } | null;
  state: string;
  commit_id: string | null;
  body: string | null;
  submitted_at?: string | null;
};

type ReviewOptions = {
  headSha: string;
  appSlug: string;
  owner: string;
  author: string;
  writers: Iterable<string>;
  machineUser?: string;
};

export function fromReviews(reviews: readonly Review[], {
  headSha, appSlug, owner, author, writers, machineUser = 'automagik-genie',
}: ReviewOptions) {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    if (review.user && review.state !== 'COMMENTED' && review.state !== 'PENDING') {
      latest.set(review.user.login, review);
    }
  }
  const app = `${appSlug}[bot]`;
  const review = latest.get(app);
  let verdict: Verdict | null = null;
  if (review?.user?.type === 'Bot' && review.commit_id === headSha) {
    const parsed = parseVerdictLine(review.body ?? '');
    if (parsed?.sha === headSha) {
      const state = parsed.kind === 'SHIP' ? 'APPROVED' : 'CHANGES_REQUESTED';
      if (review.state === state) verdict = parsed;
    }
  }

  const approvedHead = (login: string) => {
    const review = latest.get(login);
    return review?.state === 'APPROVED' && review.commit_id === headSha;
  };
  const ownerApprovedHead = approvedHead(owner);
  let teamApprovedHead = false;
  for (const login of writers) {
    if (login !== author && login !== app && login !== machineUser && approvedHead(login)) {
      teamApprovedHead = true;
      break;
    }
  }
  return { verdict, ownerApprovedHead, teamApprovedHead };
}

export type CheckRun = {
  id: number;
  name: string;
  app: { id: number } | null;
  status: string;
  conclusion: string | null;
};
export type Status = { id: number; context: string; state: string };

type GateInput = {
  headSha: string;
  base: string;
  draft: boolean;
  labels: readonly string[];
  verdict: Verdict | null;
  results: { sha: string; checks: readonly CheckRun[]; statuses: readonly Status[] };
  complete: { results: boolean; reviews: boolean; files: boolean };
  appId: number;
  classification: ReturnType<typeof classify>;
  ownerApprovedHead: boolean;
  authorCanWrite: boolean;
  teamApprovedHead: boolean;
};

function latestBy<T extends { id: number }>(records: readonly T[], keyFor: (record: T) => string) {
  const latest = new Map<string, T>();
  for (const record of records) {
    const key = keyFor(record);
    const current = latest.get(key);
    if (!current || record.id > current.id) latest.set(key, record);
  }
  return latest.values();
}

const GATE_PRECEDENCE = ['action_required', 'fail', 'wait'] as const;
type GateState = typeof GATE_PRECEDENCE[number];

export function gate(input: GateInput, rules: Rules): { state: GateState | 'pass'; reasons: string[] } {
  const { headSha, base, draft, labels, verdict, results, complete, classification } = input;
  const states = new Set<GateState>();
  const reasons: string[] = [];
  const add = (state: GateState, reason: string) => {
    states.add(state);
    reasons.push(reason);
  };

  if (draft) add('wait', 'draft');
  if (verdict?.sha !== headSha) add('wait', `no verdict at ${headSha.slice(0, 7)}`);
  else if (verdict.kind !== 'SHIP') add('fail', `${verdict.kind} at ${headSha.slice(0, 7)}`);
  if (base !== 'dev') add('fail', `base ${base} must be dev`);
  for (const label of rules.holdLabels) {
    if (labels.includes(label)) add('action_required', `hold label: ${label}`);
  }
  if (!input.ownerApprovedHead) {
    if (classification.ownerReview.length) {
      const groups = new Set(classification.ownerReview.map(({ group }) => group));
      add('action_required', `owner approval required for ${[...groups].sort().join(', ')}`);
    }
    for (const { path, word } of classification.askOwner) {
      add('action_required', `owner ruling required for ${path} (${word})`);
    }
  }
  if (!input.authorCanWrite && !input.teamApprovedHead) {
    add('action_required', 'team approval required');
  }
  for (const part of ['results', 'reviews', 'files'] as const) {
    if (!complete[part]) add('wait', `${part} not fully read`);
  }
  if (results.sha !== headSha) {
    add('wait', 'results are for another head');
  } else {
    const checks = latestBy(results.checks, run => JSON.stringify([run.app?.id ?? null, run.name]));
    for (const check of checks) {
      if (check.name === 'pr-reviewer' && check.app?.id === input.appId) continue;
      if (check.status !== 'completed') add('wait', `check ${check.name} is ${check.status}`);
      else if (!['success', 'skipped', 'neutral'].includes(check.conclusion ?? '')) {
        add('fail', `check ${check.name} concluded ${check.conclusion ?? 'without a result'}`);
      }
    }
    for (const status of latestBy(results.statuses, item => item.context.toLowerCase())) {
      if (status.state === 'pending') add('wait', `status ${status.context} is pending`);
      else if (status.state !== 'success') add('fail', `status ${status.context} is ${status.state}`);
    }
  }
  const state = draft ? 'wait' : GATE_PRECEDENCE.find(state => states.has(state)) ?? 'pass';
  return { state, reasons };
}
