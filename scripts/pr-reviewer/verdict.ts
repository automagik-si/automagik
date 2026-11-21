/** RFC 0029 D3a part 1: compose the head-bound verdict and carry-over review. */
import { verdictLine } from './rules';

type VerdictKind = Parameters<typeof verdictLine>[0];
type ReviewComment = { path: string; line: number; body: string };
type VerdictReview = {
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES';
  labels: string[];
  comments: ReviewComment[];
};

function invalid(field: string, reason: string): never {
  throw new Error(`verdict: ${field} ${reason}`);
}

function exactObject(value: unknown, required: readonly string[], field: string, optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!required.includes(key) && !optional.includes(key)) invalid(`${field}.${key}`, 'is unknown');
  }
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) invalid(`${field}.${key}`, 'is required');
  }
  return fields;
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

function array<T>(value: unknown, field: string, read: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) invalid(field, 'must be an array');
  return Array.from(value, (entry, index) => read(entry, `${field}[${index}]`));
}

function verdictKind(value: unknown, field: string): VerdictKind {
  if (value !== 'SHIP' && value !== 'FIX-FIRST' && value !== 'BLOCKED') {
    invalid(field, 'must be SHIP, FIX-FIRST, or BLOCKED');
  }
  return value;
}

function headLine(kind: VerdictKind, value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field, 'must be a 40-character lowercase commit SHA');
  try {
    return verdictLine(kind, value);
  } catch (error) {
    invalid(field, error instanceof Error ? error.message : String(error));
  }
}

function readReviewer(value: unknown, sha: unknown) {
  const field = 'input.passes.reviewer';
  const reviewer = exactObject(value, ['sha', 'verdict'], field, ['notes']);
  if (reviewer.sha !== sha) invalid(`${field}.sha`, 'must match input.sha');
  return {
    verdict: verdictKind(reviewer.verdict, `${field}.verdict`),
    notes: Object.hasOwn(reviewer, 'notes') ? nonempty(reviewer.notes, `${field}.notes`) : null,
  };
}

function httpsUrl(ref: string, field: string): URL {
  const url = URL.parse(ref);
  if (!ref.startsWith('https://') || !url || url.protocol !== 'https:' || url.username || url.password) {
    invalid(field, 'must be an HTTPS URL');
  }
  return url;
}

function proofLine(value: unknown, field: string): string {
  const { type } = exactObject(value, ['type'], field, ['ref', 'command', 'output']);
  if (type === 'text') {
    const proof = exactObject(value, ['type', 'command', 'output'], field);
    const command = nonempty(proof.command, `${field}.command`);
    const output = nonempty(proof.output, `${field}.output`);
    return `  - Proof (text): ${command}\n${output}`;
  }
  if (type === 'image' || type === 'run') {
    const keys = type === 'image' ? ['type', 'ref'] : ['type', 'ref', 'command', 'output'];
    const proof = exactObject(value, keys, field);
    const ref = nonempty(proof.ref, `${field}.ref`);
    const url = httpsUrl(ref, `${field}.ref`);
    if (type === 'image') return `  - Proof (image): ${ref}`;
    if (url.host !== 'github.com' || !/^\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?\/?$/.test(url.pathname)) {
      invalid(`${field}.ref`, 'must be a GitHub Actions run URL');
    }
    const command = nonempty(proof.command, `${field}.command`);
    const output = nonempty(proof.output, `${field}.output`);
    return `  - Proof (run): ${ref}\n    Command: ${command}\n    Output: ${output}`;
  }
  invalid(`${field}.type`, 'must be image, text, or run');
}

function readDogfooder(value: unknown, sha: unknown) {
  const field = 'input.passes.dogfooder';
  const dogfooder = exactObject(value, ['sha', 'verdict', 'gate', 'tests', 'mutant'], field, ['proof']);
  if (dogfooder.sha !== sha) invalid(`${field}.sha`, 'must match input.sha');
  const verdict = verdictKind(dogfooder.verdict, `${field}.verdict`);
  const hasProof = Object.hasOwn(dogfooder, 'proof');
  if (verdict === 'SHIP' && !hasProof) invalid(`${field}.proof`, 'is required');
  return {
    verdict,
    gate: nonempty(dogfooder.gate, `${field}.gate`),
    tests: nonempty(dogfooder.tests, `${field}.tests`),
    mutant: nonempty(dogfooder.mutant, `${field}.mutant`),
    proof: hasProof ? proofLine(dogfooder.proof, `${field}.proof`) : null,
  };
}

function readFinding(value: unknown, field: string) {
  const finding = exactObject(value, ['n', 'text', 'inline'], field, ['path', 'line']);
  flag(finding.inline, `${field}.inline`);
  return {
    n: positiveInt(finding.n, `${field}.n`),
    path: Object.hasOwn(finding, 'path') ? nonempty(finding.path, `${field}.path`) : null,
    line: Object.hasOwn(finding, 'line') ? positiveInt(finding.line, `${field}.line`) : null,
    text: nonempty(finding.text, `${field}.text`),
  };
}

function section(name: string, lines: string[]) {
  return `## ${name}\n\n${lines.length ? lines.join('\n') : 'None.'}`;
}

export function composeVerdict(value: unknown): VerdictReview {
  const input = exactObject(value, ['kind', 'sha', 'docsOnly', 'passes', 'findings', 'rfcLines', 'gates'], 'input', ['decision']);
  const kind = verdictKind(input.kind, 'input.kind');
  const firstLine = headLine(kind, input.sha, 'input.sha');
  const docsOnly = flag(input.docsOnly, 'input.docsOnly');
  const passes = exactObject(input.passes, ['reviewer'], 'input.passes', ['dogfooder']);
  const reviewer = readReviewer(passes.reviewer, input.sha);
  const dogfooder = Object.hasOwn(passes, 'dogfooder') ? readDogfooder(passes.dogfooder, input.sha) : null;
  const findings = array(input.findings, 'input.findings', readFinding);
  const rfcLines = array(input.rfcLines, 'input.rfcLines', nonempty);
  const gates = array(input.gates, 'input.gates', nonempty);
  const decision = Object.hasOwn(input, 'decision') ? nonempty(input.decision, 'input.decision') : null;

  if (!docsOnly && !dogfooder) invalid('input.passes.dogfooder', 'is required for code reviews');
  if (kind === 'SHIP') {
    if (findings.length) invalid('input.findings', 'must be empty for SHIP');
    if (reviewer.verdict !== 'SHIP') invalid('input.passes.reviewer.verdict', 'must be SHIP');
    if (!docsOnly && dogfooder?.verdict !== 'SHIP') invalid('input.passes.dogfooder.verdict', 'must be SHIP');
  }
  if (kind === 'FIX-FIRST' && !findings.length) invalid('input.findings', 'must have a finding for FIX-FIRST');
  if (kind === 'BLOCKED' && decision === null) invalid('input.decision', 'is required for BLOCKED');

  const passLines = [`- Reviewer: ${reviewer.verdict}`];
  if (reviewer.notes !== null) passLines.push(reviewer.notes);
  if (dogfooder) {
    passLines.push(
      `- Dogfooder: ${dogfooder.verdict}`,
      `  - Gate: ${dogfooder.gate}`,
      `  - Tests: ${dogfooder.tests}`,
      `  - Mutant: ${dogfooder.mutant}`,
    );
    if (dogfooder.proof !== null) passLines.push(dogfooder.proof);
  }

  const comments: ReviewComment[] = [];
  const seen = new Set<number>();
  const findingLines = findings.map(({ n, path, line, text }, index) => {
    if (seen.has(n)) invalid(`input.findings[${index}].n`, 'is a duplicate');
    seen.add(n);
    if (kind === 'FIX-FIRST') {
      if (path === null) invalid(`input.findings[${index}].path`, 'is required for FIX-FIRST');
      if (line === null) invalid(`input.findings[${index}].line`, 'is required for FIX-FIRST');
      comments.push({ path, line, body: text });
    }
    const location = path === null ? (line === null ? '' : `line ${line}`) : (line === null ? path : `${path}:${line}`);
    return `${n}. ${location ? `\`${location}\` ` : ''}${text}`;
  });

  const body = [
    firstLine,
    section('Passes', passLines),
    section('Findings', findingLines),
    section('RFC system', rfcLines),
    section('Gates', gates),
  ];
  if (decision !== null) body.push(section('Decision', [decision]));

  return {
    body: body.join('\n\n'),
    event: kind === 'SHIP' ? 'APPROVE' : 'REQUEST_CHANGES',
    labels: kind === 'BLOCKED' ? ['blocked'] : [],
    comments,
  };
}

export function composeCarry(value: unknown): string {
  const carry = exactObject(value, ['from', 'to', 'kind'], 'carry');
  if (carry.kind !== 'SHIP') invalid('carry.kind', 'must be SHIP');
  headLine('SHIP', carry.from, 'carry.from');
  const firstLine = headLine('SHIP', carry.to, 'carry.to');
  return `${firstLine}\n\ncarried from ${carry.from}: the PR's own diff is unchanged; dev merged in, CI green`;
}
