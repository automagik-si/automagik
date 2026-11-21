/** RFC 0029 (i), D3a part 2: mechanical RFC checks over an offline PR snapshot. */

const RFC_DIR = 'docs/rfcs/';
const RFC_FILE = /^(\d{4})-[^/]+\.md$/;
const HEADER_FIELDS = ['Status', 'Milestone', 'Lanes', 'Created'];
const longestFirst = (a: string, b: string) => b.length - a.length;
// Also used by the standalone parser, which has no README snapshot.
const STATUS_VALUES = [
  'Proposed', 'Queued', 'Accepted', 'In delivery', 'Delivered', 'Proposal-only', 'Parked', 'Superseded',
].sort(longestFirst);
const RELEASE_LANES = ['full', 'plugins', 'herdr', 'pocket', 'am', 'meter'] as const;

type LaneKind = typeof RELEASE_LANES[number];

type IndexRow = { number: number; file: string; title: string; status: string; milestone: string };
type Finding = { rule: string; verdict: 'BLOCKED' | 'FIX-FIRST'; text: string; path?: string; line?: number };
type FollowUp = { rule: string; text: string };

function invalid(field: string, reason: string): never {
  throw new Error(`rfc-checks: ${field} ${reason}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'must be an object');
  return value as Record<string, unknown>;
}

function exactObject(value: unknown, keys: readonly string[], field: string, optional: readonly string[] = []) {
  const record = object(value, field);
  for (const key of Object.keys(record)) {
    if (!keys.includes(key) && !optional.includes(key)) invalid(`${field}.${key}`, 'is unknown');
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) invalid(`${field}.${key}`, 'is required');
  }
  return record;
}

function array<T>(value: unknown, field: string, read: (value: unknown, field: string) => T): T[] {
  if (!Array.isArray(value)) invalid(field, 'must be an array');
  return Array.from(value, (entry, index) => read(entry, `${field}[${index}]`));
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field, 'must be a string');
  return value;
}

function nonempty(value: unknown, field: string): string {
  const text = string(value, field);
  if (!text.trim()) invalid(field, 'must not be empty');
  return text;
}

function integer(value: unknown, field: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(field, `must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readChangedFile(value: unknown, field: string) {
  const file = exactObject(value, ['path', 'status'], field, ['previousPath']);
  if (file.status !== 'added' && file.status !== 'modified' && file.status !== 'removed' && file.status !== 'renamed') {
    invalid(field + '.status', 'must be added, modified, removed, or renamed');
  }
  return {
    path: nonempty(file.path, field + '.path'),
    status: file.status,
    previousPath: Object.hasOwn(file, 'previousPath') ? nonempty(file.previousPath, field + '.previousPath') : undefined,
  };
}

function readClaim(value: unknown, field: string) {
  const claim = exactObject(value, ['pr', 'rfcNumber'], field);
  return { pr: integer(claim.pr, field + '.pr', 1), rfcNumber: integer(claim.rfcNumber, field + '.rfcNumber', 0, 9999) };
}

function readIssue(value: unknown, field: string) {
  const issue = exactObject(value, ['number', 'labels', 'state'], field);
  if (issue.state !== 'open' && issue.state !== 'closed') invalid(field + '.state', 'must be open or closed');
  return {
    number: integer(issue.number, field + '.number', 1),
    labels: array(issue.labels, field + '.labels', nonempty),
  };
}

function readLane(value: unknown) {
  const { ships, kind } = exactObject(value, ['ships', 'kind'], 'input.lane');
  if (ships !== null && typeof ships !== 'boolean') invalid('input.lane.ships', 'must be a boolean or null');
  if (kind !== null && (typeof kind !== 'string' || !RELEASE_LANES.includes(kind as LaneKind))) {
    invalid('input.lane.kind', 'must be a release lane or null');
  }
  return { ships, kind: kind as LaneKind | null };
}

function readInput(value: unknown) {
  const input = exactObject(value, ['repo', 'pr', 'base', 'head', 'openPrClaims', 'issues', 'lane'], 'input');
  const pr = exactObject(input.pr, ['title', 'body', 'commits', 'files'], 'input.pr');
  const base = exactObject(input.base, ['rfcFiles', 'readme'], 'input.base');
  const head = exactObject(input.head, ['readme', 'files'], 'input.head');
  const headFiles = new Map<string, string>();
  for (const [path, content] of Object.entries(object(head.files, 'input.head.files'))) {
    headFiles.set(path, string(content, `input.head.files[${JSON.stringify(path)}]`));
  }
  return {
    repo: nonempty(input.repo, 'input.repo'),
    pr: {
      title: string(pr.title, 'input.pr.title'),
      body: string(pr.body, 'input.pr.body'),
      commits: array(pr.commits, 'input.pr.commits', string),
      files: array(pr.files, 'input.pr.files', readChangedFile),
    },
    base: { rfcFiles: array(base.rfcFiles, 'input.base.rfcFiles', nonempty), readme: string(base.readme, 'input.base.readme') },
    head: { readme: string(head.readme, 'input.head.readme'), files: headFiles },
    openPrClaims: array(input.openPrClaims, 'input.openPrClaims', readClaim),
    issues: array(input.issues, 'input.issues', readIssue),
    lane: readLane(input.lane),
  };
}

function section(readme: string, heading: string): string[] {
  const lines = readme.split(/\r?\n/);
  const start = lines.findIndex(line => line.trimEnd() === '## ' + heading);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

function tableCells(line = ''): string[] {
  const row = line.trim();
  if (!row.startsWith('|') || !row.endsWith('|')) return [];
  return row.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
}

function tableRows(lines: string[], columns: string[]): string[][] {
  const first = lines.findIndex(line => line.trim());
  if (first === -1) return [];
  const header = tableCells(lines[first]);
  const separator = tableCells(lines[first + 1]);
  if (header.length !== columns.length || !columns.every((column, index) => header[index] === column)) return [];
  if (separator.length !== columns.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(first + 2)) {
    const cells = tableCells(line);
    if (!cells.length) break;
    if (cells.length === columns.length) rows.push(cells);
  }
  return rows;
}

export function parseIndex(readme: string): IndexRow[] {
  const rows: IndexRow[] = [];
  for (const [link, title, status, milestone] of tableRows(section(readme, 'Index'), ['#', 'Title', 'Status', 'Milestone'])) {
    const match = /^\[(\d{4})\]\((\d{4}-[^/()]+\.md)\)$/.exec(link);
    if (match && match[2].startsWith(match[1] + '-')) {
      rows.push({ number: Number(match[1]), file: match[2], title, status, milestone });
    }
  }
  return rows;
}

function matchStatus(status: string, values: readonly string[]): string | null {
  const text = status.trim();
  return values.find(value => {
    const suffix = text.slice(value.length);
    return text.startsWith(value) && (suffix === '' || /^( \(|,|;)/.test(suffix));
  }) ?? null;
}

export function statusWord(status: string): string | null {
  return matchStatus(status, STATUS_VALUES);
}

export function parseHeader(markdown: string) {
  const lines = markdown.trimStart().split(/\r?\n/);
  const heading = /^# RFC (\d{4}): (\S.*)$/.exec(lines[0].trimEnd());
  const fields = tableRows(lines.slice(1), ['Field', 'Value']).map(([name, value]) => ({ name, value }));
  return { number: heading ? Number(heading[1]) : null, title: heading?.[2] ?? null, fields };
}

const MARKDOWN_FENCE = String.raw`^ {0,3}(?=(?<mark>[\x60~]))(?<fence>\x60{3,}(?!\x60)(?=[^\x60\r\n]*$)|~{3,}(?!~))[^\r\n]*(?:\r?\n|$)`
  + String.raw`[\s\S]*?(?:^ {0,3}\k<fence>\k<mark>*[ \t]*(?=\r?$)|(?![\s\S]))`;
const HIDDEN_MARKDOWN = new RegExp([
  MARKDOWN_FENCE,
  String.raw`<!--[\s\S]*?(?:-->|(?![\s\S]))`,
  // Inline code is stripped only within one line: a span that would cross a line (list items, paragraphs) is left
  // visible, so an unmatched backtick never hides a reference.
  String.raw`(?<!\x60)(?<ticks>\x60+)(?!\x60)[^\r\n]*?(?<!\x60)\k<ticks>(?!\x60)`,
].join('|'), 'gm');

function stripMarkdown(text: string): string {
  return text.replace(HIDDEN_MARKDOWN, match => match.replace(/[^\r\n]/g, ' '));
}

const ISSUE = String.raw`(?:([\w.-]+\/[\w.-]+))?#(\d+)\b`;
const ISSUE_NUMBER = new RegExp(ISSUE, 'g');
const ISSUE_REFERENCE = new RegExp(
  String.raw`\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?|refs?):?\s+` +
  String.raw`(${ISSUE}(?:(?:[ \t]*,(?:[ \t]|\r?\n)*(?:and\s+)?|\s+and\s+)${ISSUE})*)`, 'gi',
);
const PARTIAL_BODY = /\b(?:in[ \t]+part\b|part[ \t]+\d)/i;
const PARTIAL_TITLE = /\bpartial\b/i;

function localIssueNumbers(text: string, repository: string): number[] {
  const numbers: number[] = [];
  for (const [, qualifier, digits] of text.matchAll(ISSUE_NUMBER)) {
    const number = Number(digits);
    if (number > 0 && Number.isSafeInteger(number) && (!qualifier || qualifier.toLowerCase() === repository)) {
      numbers.push(number);
    }
  }
  return numbers;
}

function issueReferences(body: string, repo: string) {
  const closing = new Set<number>();
  const refs = new Set<number>();
  const closingLines = new Set<number>();
  const repository = repo.toLowerCase();
  for (const match of body.matchAll(ISSUE_REFERENCE)) {
    const [, keyword, list] = match;
    const numbers = localIssueNumbers(list, repository);
    const isRef = /^refs?$/i.test(keyword);
    const target = isRef ? refs : closing;
    for (const number of numbers) target.add(number);
    if (!isRef && numbers.length) {
      const end = match.index! + match[0].length;
      closingLines.add(body.lastIndexOf('\n', end - 1) + 1);
    }
  }

  const partialClosures = new Set<number>();
  const ambiguousPartial: number[][] = [];
  for (const start of closingLines) {
    const end = body.indexOf('\n', start);
    const line = body.slice(start, end === -1 ? undefined : end);
    if (!PARTIAL_BODY.test(line)) continue;
    const numbers = localIssueNumbers(line, repository);
    if (numbers.length === 1) partialClosures.add(numbers[0]);
    else ambiguousPartial.push([...new Set(numbers)]);
  }
  return { closing, refs, partialClosures, ambiguousPartial };
}

export function references(body: string, repo = ''): { closing: number[]; refs: number[] } {
  const { closing, refs } = issueReferences(stripMarkdown(body), repo);
  return { closing: [...closing], refs: [...refs] };
}

function rfcMentions(text: string) {
  const named = new Set<number>();
  const deliveries = new Set<number>();
  const mentions = /\bRFC[ \t]+(\d{4}|\d{2})\b(?:(?:,(?=[ \t]+deliver(?:y|ies)\b))?[ \t]+([A-Z]?\d+[a-z]?|deliver(?:y|ies)[ \t]+\d+[a-z]?(?:-\d+[a-z]?)?|(?:part|step)[ \t]+\d+)\b)?/gi;
  for (const [, digits, delivery] of text.matchAll(mentions)) {
    const number = Number(digits);
    named.add(number);
    if (delivery) deliveries.add(number);
  }
  return { named, deliveries };
}

export function namedRfcs(title: string, body: string): number[] {
  return [...rfcMentions(stripMarkdown(title) + '\n' + stripMarkdown(body)).named];
}

export function namedDelivery(title: string, body: string): boolean {
  return rfcMentions(stripMarkdown(title) + '\n' + stripMarkdown(body)).deliveries.size > 0;
}

function rfcNumber(file: string): number | undefined {
  const match = RFC_FILE.exec(file);
  return match ? Number(match[1]) : undefined;
}

function formatted(number: number): string {
  return String(number).padStart(4, '0');
}

// Every line of the Index section that starts like a row, readable or not: a second row the table parser drops (a
// missing trailing pipe, say) must still count as a duplicate, never leave the other row as the only evidence.
function looseRowNumbers(readme: string, duplicates: Set<number>) {
  const seen = new Set<number>();
  for (const line of section(readme, 'Index')) {
    const match = /^\s*\|?\s*\[(\d{4})\]/.exec(line);
    if (!match) continue;
    const number = Number(match[1]);
    if (seen.has(number)) duplicates.add(number);
    seen.add(number);
  }
}

function indexByNumber(rows: IndexRow[], duplicates: Set<number>): Map<number, IndexRow> {
  const index = new Map<number, IndexRow>();
  for (const row of rows) {
    if (index.has(row.number)) duplicates.add(row.number);
    else index.set(row.number, row);
  }
  return index;
}

function sameRow(base: IndexRow, head: IndexRow): boolean {
  return base.file === head.file && base.title === head.title && base.status === head.status && base.milestone === head.milestone;
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toJSON()?.slice(0, 10) === value;
}

type AddFinding = (rule: string, text: string, path?: string) => void;

function checkNewHeader(
  path: string, number: number, content: string, row: IndexRow | undefined, values: readonly string[], fix: AddFinding,
) {
  const header = parseHeader(content);
  if (header.number !== number) fix('rfc-header', `Use the heading # RFC ${formatted(number)}: <title>.`, path);
  for (const [index, name] of HEADER_FIELDS.entries()) {
    const field = header.fields[index];
    if (field?.name !== name || !field.value) {
      fix('rfc-header', `Put a non-empty ${name} field in position ${index + 1} of the Field/Value table.`, path);
    } else if (name === 'Created' && !validDate(field.value)) {
      fix('rfc-header', 'Use a YYYY-MM-DD date in the Created field.', path);
    }
  }
  const status = matchStatus(header.fields.find(field => field.name === 'Status')?.value ?? '', values);
  if (!status || (row && status !== matchStatus(row.status, values))) {
    fix('rfc-status', 'Use matching status words from the Status values table in the RFC header and index row.', path);
  }
}

function checkNewFiles(
  { pr, base, head, openPrClaims }: ReturnType<typeof readInput>, rows: IndexRow[],
  duplicates: Set<number>, outsideDocs: boolean, values: readonly string[], fix: AddFinding,
) {
  const baseFiles = base.rfcFiles.map(file => ({ file, number: rfcNumber(file) }));
  const baseNumbers = baseFiles.flatMap(({ number }) => number === undefined ? [] : [number]);
  const claims = [...openPrClaims].sort((a, b) => a.rfcNumber - b.rfcNumber || a.pr - b.pr);
  const claimedNumbers = new Set(claims.map(({ rfcNumber }) => rfcNumber));
  let expected = Math.max(0, ...baseNumbers) + 1;
  const newNumbers = new Set<number>();
  const files = [...pr.files].sort((a, b) => compare(a.path, b.path));

  for (const { path, status, previousPath } of files) {
    if (!path.startsWith(RFC_DIR) || (status !== 'added' && status !== 'renamed')) continue;
    const file = path.slice(RFC_DIR.length);
    const number = rfcNumber(file);
    if (number === undefined) continue;
    const content = head.files.get(path) ?? '';
    if (status === 'renamed' && previousPath?.startsWith(RFC_DIR) &&
      rfcNumber(previousPath.slice(RFC_DIR.length)) === number) continue;
    const companions = status === 'added' ? baseFiles.filter(entry => entry.number === number) : [];
    if (companions.length) {
      const visible = stripMarkdown(content);
      if (!companions.some(entry => visible.includes('](' + entry.file + ')'))) {
        fix('rfc-companion', `Link to RFC ${formatted(number)} in the companion page.`, path);
      }
      continue;
    }

    while (claimedNumbers.has(expected) || newNumbers.has(expected)) expected++;
    if (newNumbers.has(number)) {
      fix('rfc-number', `This PR adds more than one RFC numbered ${formatted(number)}.`, path);
    } else if (number !== expected) {
      const claimed = claims.map(claim => `PR #${claim.pr} claims ${formatted(claim.rfcNumber)}`).join(', ');
      fix('rfc-number', `Use RFC ${formatted(expected)} as the next free number.` +
        (claimed ? ` Open claims: ${claimed}.` : ''), path);
    }
    newNumbers.add(number);
    const row = rows.find(row => row.number === number && row.file === file);
    if (!row) fix('rfc-row', `Add the RFC ${formatted(number)} row for ${file} to docs/rfcs/README.md.`, path);
    checkNewHeader(path, number, content, duplicates.has(number) ? undefined : row, values, fix);
    if (outsideDocs) {
      fix('rfc-docs-only', 'Keep the new RFC PR under docs/.', path);
    }
    if (pr.commits.some(subject => !/^docs\(rfcs\): \S/.test(subject))) {
      fix('rfc-commits', 'Use docs(rfcs): ... for every commit in a new RFC PR.', path);
    }
  }
}

export function rfcChecks(input: unknown): {
  findings: Finding[]; followUps: FollowUp[]; forReviewer: string[]; lane: ReturnType<typeof readLane>;
} {
  const snapshot = readInput(input);
  const { repo, pr, head, base, issues, lane } = snapshot;
  const findings: Finding[] = [];
  const followUps: FollowUp[] = [];
  const forReviewer: string[] = [];
  const fix: AddFinding = (rule, text, path) => {
    findings.push({ rule, verdict: 'FIX-FIRST', text, ...(path === undefined ? {} : { path }) });
  };
  const values = tableRows(section(base.readme, 'Status values'), ['Status', 'Meaning'])
    .map(([status]) => status).filter(Boolean).sort(longestFirst);
  const statuses = values.length ? values : STATUS_VALUES;
  const headRows = parseIndex(head.readme);
  const duplicates = new Set<number>();
  const headIndex = indexByNumber(headRows, duplicates);
  const baseIndex = indexByNumber(parseIndex(base.readme), duplicates);
  looseRowNumbers(head.readme, duplicates);
  looseRowNumbers(base.readme, duplicates);
  for (const number of [...duplicates].sort((a, b) => a - b)) {
    fix('rfc-row', `RFC ${formatted(number)} has two index rows.`, RFC_DIR + 'README.md');
  }
  const title = stripMarkdown(pr.title);
  const body = stripMarkdown(pr.body);
  const { named: titleRfcs, deliveries } = rfcMentions(title);
  const deliveredRfcs = [...(deliveries.size ? deliveries : titleRfcs)].sort((a, b) => a - b);
  const baseStatus = (number: number) => duplicates.has(number) ? null : matchStatus(baseIndex.get(number)?.status ?? '', statuses);
  const headStatus = (number: number) => duplicates.has(number) ? null : matchStatus(headIndex.get(number)?.status ?? '', statuses);
  const acceptanceRfcs = titleRfcs.size ? titleRfcs : rfcMentions(body).named;
  const accepted = (number: number) => ['Accepted', 'In delivery'].includes(baseStatus(number) ?? '');
  const hasAccepted = [...acceptanceRfcs].some(accepted);
  const allAccepted = [...acceptanceRfcs].every(accepted);
  const allDelivered = [...titleRfcs].every(number => headStatus(number) === 'Delivered');
  const changedPaths = pr.files.flatMap(({ path, previousPath }) => previousPath === undefined ? [path] : [path, previousPath]);
  const outsideRfcs = changedPaths.some(path => !path.startsWith(RFC_DIR));
  // Code means a changed file that is neither under docs/ nor Markdown: a README beside a package documents, it ships
  // no behaviour, so it does not make the PR a delivery.
  const outsideDocs = changedPaths.some(path => !path.startsWith('docs/') && !path.endsWith('.md'));

  checkNewFiles(snapshot, headRows, duplicates, outsideDocs, statuses, fix);

  if (outsideDocs) {
    if (!deliveries.size && deliveredRfcs.some(number => baseIndex.has(number))) {
      fix('rfc-delivery', 'Name the RFC delivery in the PR title.');
    }
    for (const number of deliveredRfcs) {
      if (duplicates.has(number)) continue;
      const row = baseIndex.get(number);
      if (!row) {
        // An explicit delivery of an unindexed RFC is a typo to fix; a bare citation may be an outside standard
        // (RFC 8252, say), which the Reviewer pass judges.
        if (deliveries.has(number)) fix('rfc-delivery', `RFC ${formatted(number)} is not in the index.`);
        else forReviewer.push(`Check the title's RFC ${formatted(number)}: it is not in this repository's index.`);
        continue;
      }
      const headRow = headIndex.get(number);
      if (!headRow || sameRow(row, headRow)) {
        followUps.push({ rule: 'rfc-delivery-row', text: `Move RFC ${formatted(number)}'s row.` });
      }
      if (baseStatus(number) === 'Accepted' && headStatus(number) === 'Accepted') {
        followUps.push({ rule: 'rfc-delivery-row', text: `Move RFC ${formatted(number)} to In delivery.` });
      }
    }
  }

  if (lane.ships === null || (lane.ships && lane.kind === null)) fix('lane', 'lane unknown');

  const { closing, refs, partialClosures, ambiguousPartial } = issueReferences(body, repo);
  const referenced = [...new Set([...closing, ...refs])].sort((a, b) => a - b);
  const needsRfc = new Set(issues.filter(issue => issue.labels.includes('needs-rfc')).map(issue => issue.number));
  const needsRfcClosures = [...closing].filter(number => needsRfc.has(number));
  const completionAmbiguity = !titleRfcs.size ? 'The PR title names no RFC.' :
    needsRfcClosures.length > 1 ? 'This PR closes multiple needs-rfc issues.' : '';
  const partialTitle = PARTIAL_BODY.test(title) || PARTIAL_TITLE.test(title);
  const needsRfcReferenced = referenced.filter(number => needsRfc.has(number));
  // Several needs-rfc issues and RFCs not all accepted: which RFC answers which issue is not mechanical.
  const acceptanceAmbiguous = needsRfcReferenced.length > 1 && hasAccepted && !allAccepted;
  for (const number of referenced) {
    if (outsideRfcs && needsRfc.has(number) && !hasAccepted) {
      findings.push({ rule: 'needs-rfc', verdict: 'BLOCKED', text: `Issue #${number} needs an Accepted or In delivery RFC.` });
    } else if (outsideRfcs && needsRfc.has(number) && acceptanceAmbiguous) {
      forReviewer.push(`Confirm that issue #${number}'s RFC is Accepted or In delivery: the PR names RFCs in mixed states.`);
    }
    if (!closing.has(number)) continue;
    if (needsRfc.has(number) && completionAmbiguity) {
      forReviewer.push(`Confirm which RFC completes issue #${number} before closing it. ${completionAmbiguity}`);
    }
    const undelivered = needsRfc.has(number) && !completionAmbiguity && !allDelivered;
    const partial = partialTitle || partialClosures.has(number);
    const detail = partial ? `This PR describes partial work on issue #${number}. ` : '';
    if (undelivered) fix('closing-keyword', `${detail}Say Refs #${number} until the last delivery.`);
    else if (partial) fix('closing-keyword', `${detail}Say Refs #${number}.`);
  }
  for (const numbers of ambiguousPartial) {
    forReviewer.push(`Check which issue the partial-work wording applies to on the line referencing ${numbers.map(number => `#${number}`).join(', ')}.`);
  }

  findings.sort((a, b) => compare(a.rule, b.rule) || compare(a.path ?? '', b.path ?? ''));
  return { findings, followUps, forReviewer, lane };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
