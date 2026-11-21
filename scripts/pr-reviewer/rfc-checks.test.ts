/** RFC 0029 (i), D3a part 2: test the mechanical checks with offline snapshots. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { namedDelivery, namedRfcs, parseHeader, parseIndex, references, rfcChecks, statusWord } from './rfc-checks';

const rfcDir = join(import.meta.dir, '../../docs/rfcs');
const realReadme = readFileSync(join(rfcDir, 'README.md'), 'utf8');
const statusTable = realReadme.slice(realReadme.indexOf('## Status values'), realReadme.indexOf('## Process'));
const repo = 'automagik-si/automagik';
const baseFile = '0044-existing.md';
const newFile = '0045-new.md';
const newPath = 'docs/rfcs/' + newFile;
const needsRfc = { number: 20, labels: ['needs-rfc'], state: 'open' };
const sourceFile = { path: 'scripts/example.ts', status: 'modified' };

function indexRow(file: string, status: string) {
  return '| [' + file.slice(0, 4) + '](' + file + ') | Example | ' + status + ' | not scheduled |';
}

function readme(...rows: string[]) {
  return statusTable + '## Index\n\n| # | Title | Status | Milestone |\n|---|---|---|---|\n' + rows.join('\n') + '\n';
}

function rfc(number: string, status = 'Proposed', lanes = 'plugin (3.N.P)') {
  return [
    '# RFC ' + number + ': Example',
    '',
    '| Field | Value |',
    '|---|---|',
    '| Status | ' + status + ' |',
    '| Milestone | not scheduled |',
    '| Lanes | ' + lanes + ' |',
    '| Created | 2026-11-21 |',
    '',
    '## Summary',
  ].join('\n');
}

function snapshot() {
  const baseReadme = readme(indexRow(baseFile, 'Accepted'));
  return {
    repo,
    pr: { title: '', body: '', commits: ['docs(rfcs): propose an RFC'], files: [] as { path: string; status: string; previousPath?: string }[] },
    base: { rfcFiles: ['README.md', baseFile], readme: baseReadme },
    head: { readme: baseReadme, files: {} as Record<string, string> },
    openPrClaims: [] as { pr: number; rfcNumber: number }[],
    issues: [] as typeof needsRfc[],
    lane: { ships: false as boolean | null, kind: null as string | null },
  };
}

function newRfc(file = newFile, status = 'Proposed') {
  const input = snapshot();
  const path = 'docs/rfcs/' + file;
  input.pr = { ...input.pr, title: 'RFC ' + file.slice(0, 4), files: [{ path, status: 'added' }] };
  input.head = { readme: readme(indexRow(baseFile, 'Accepted'), indexRow(file, status)), files: { [path]: rfc(file.slice(0, 4)) } };
  return input;
}

function delivery(status = 'In delivery') {
  const input = snapshot();
  input.pr = { ...input.pr, title: 'RFC 44 D2a', body: 'Refs #20', files: [sourceFile] };
  input.issues = [needsRfc];
  input.head.readme = readme(indexRow(baseFile, status));
  return input;
}

const emptyReport = { findings: [], followUps: [], forReviewer: [], lane: { ships: false, kind: null } };

describe('RFC document parsers', () => {
  test('parses every real Index row and recognizes every status in the table and index', () => {
    const index = realReadme.split('## Index\n')[1].split('\n\nMilestones,')[0];
    const rowNumbers = Array.from(index.matchAll(/^\| \[(\d{4})\]/gm), match => Number(match[1]));
    const rows = parseIndex(realReadme);
    expect(rowNumbers.length).toBeGreaterThan(0);
    expect(rows.map(row => row.number)).toEqual(rowNumbers);
    expect(rows.find(row => row.number === 16)).toEqual({
      number: 16, file: '0016-windows-wslc.md', title: 'Windows on a Linux sandbox (WSL containers)',
      status: expect.stringMatching(/^In delivery /), milestone: 'not scheduled',
    });
    const statusValues = Array.from(statusTable.matchAll(/^\| (?!Status \|)([A-Za-z][A-Za-z -]+) \| .+\|$/gm), match => match[1]);
    expect(statusValues).toHaveLength(8);
    for (const status of statusValues) expect(statusWord(status)).toBe(status);
    for (const row of rows) expect(statusValues).toContain(statusWord(row.status) as string);
  });

  test('limits index parsing to the Index table and handles CRLF and escaped pipes', () => {
    const ignored = indexRow('0001-ignored.md', 'Accepted');
    const row = indexRow(baseFile, 'Accepted').replace('Example', String.raw`Example \| test`);
    const text = ignored + '\n' + readme(row) + '\n## Examples\n\n' + ignored;
    expect(parseIndex(text.replaceAll('\n', '\r\n'))).toEqual([{
      number: 44, file: baseFile, title: String.raw`Example \| test`, status: 'Accepted', milestone: 'not scheduled',
    }]);
  });

  test('uses status word boundaries and reads Accepted, in delivery as Accepted', () => {
    for (const status of ['Accepted', 'Accepted, in delivery', 'Accepted (first PR)', 'Accepted; queued']) {
      expect(statusWord(status)).toBe('Accepted');
    }
    for (const status of ['acceptED', 'Acceptedly', 'Accepted for delivery', 'Active', '']) {
      expect(statusWord(status)).toBeNull();
    }
  });

  test('parses the real Windows RFC’s heading and fields in order', () => {
    const header = parseHeader(readFileSync(join(rfcDir, '0016-windows-wslc.md'), 'utf8'));
    expect(header.number).toBe(16);
    expect(header.title).toBe('Windows on a Linux sandbox (WSL containers)');
    expect(header.fields.map(field => field.name)).toEqual(['Status', 'Milestone', 'Lanes', 'Created', 'Amends']);
    expect(header.fields[3].value).toBe('2026-11-04');
  });

  test('requires a header table next to the heading', () => {
    expect(parseHeader('# RFC 0045: Example\n\nIntroduction\n\n' + rfc('0045')).fields).toEqual([]);
  });

  test('separates closing keywords and explicit references without duplicate issue numbers', () => {
    expect(references('Fixes #9; fixed #4; RESOLVES #11.\nRefs #4, REF #15 and ref #4. Closes #9.\n' +
      'prefixes #30, unresolved #31, other/project#32, Fixes other/project#33, see #34.')).toEqual({
      closing: [9, 4, 11], refs: [4, 15],
    });
    expect(references('Close #1 Closes #2 Closed #3 Fix #4 Fixes #5 Fixed #6 Resolve #7 Resolves #8 Resolved #9').closing)
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('reads every issue in #1865’s reference list and in closing keyword lists', () => {
    expect(references('Refs #1425, #1528')).toEqual({ closing: [], refs: [1425, 1528] });
    expect(references('Refs #1, #2 and #3. Fixes #4, #5. Closes #6, other/repo#7, and automagik-si/automagik#8.', repo))
      .toEqual({ closing: [4, 5, 6, 8], refs: [1, 2, 3] });
    const input = snapshot();
    input.pr.body = 'Refs #1425, #1528';
    input.pr.files = [sourceFile];
    input.issues = [{ ...needsRfc, number: 1528 }];
    expect(rfcChecks(input)).toEqual({
      ...emptyReport,
      findings: [{ rule: 'needs-rfc', verdict: 'BLOCKED', text: 'Issue #1528 needs an Accepted or In delivery RFC.' }],
    });
  });

  test('recognizes short and padded RFC numbers and named deliveries in title or body', () => {
    expect(namedRfcs('RFC 0029 D3a', 'rfc 16 and RFC 0029, RFC 0044, RFC 3, RFC 101, RFC 10000')).toEqual([29, 16, 44]);
    expect(namedDelivery('RFC 0029 D3a', '')).toBe(true);
    expect(namedDelivery('', 'RFC 16, delivery 4b')).toBe(true);
    expect(namedDelivery('RFC 0029 D3ab', 'deliveries 8 and 9')).toBe(false);
  });

  test('associates all delivery ID forms with an RFC mention', () => {
    for (const id of ['D3a', 'R4', 'P3', '3c', '3', 'delivery 4b', 'part 2']) {
      expect(namedDelivery('RFC 0029 ' + id, '')).toBe(true);
    }
    expect(namedDelivery('RFC 0029', 'Delivery 2')).toBe(false);
  });

  test('ignores RFC names, delivery IDs and references inside Markdown examples', () => {
    const body = [
      '```md',
      'Fixes #991. RFC 0099 D5a.',
      '```',
      '  ~~~~text',
      '~~~',
      'Fixes #991. RFC 0098 3c.',
      '  ~~~~~',
      'Use ``Refs #991 and RFC 0097 part 2`` as an example.',
      '<!-- Ref #991',
      'RFC 0096 delivery 1 -->',
      'Refs #42. See RFC 0044.',
    ].join('\n');
    expect(references(body, repo)).toEqual({ closing: [], refs: [42] });
    expect(namedRfcs('` RFC 29 D3a `', body)).toEqual([44]);
    expect(namedDelivery('RFC 0044', body)).toBe(false);
    expect(namedDelivery('RFC 0044 ` D2a `', '')).toBe(false);
  });

  test('keeps a closure between paragraphs with unmatched backticks', () => {
    const input = snapshot();
    input.pr.files = [sourceFile];
    input.issues = [{ ...needsRfc, number: 991 }];
    for (const blankLine of ['\n\n', '\r\n \t\r\n']) {
      input.pr.body = ['One literal ` tick.', 'Fixes #991', 'Another literal ` tick.'].join(blankLine);
      expect(references(input.pr.body)).toEqual({ closing: [991], refs: [] });
      expect(rfcChecks(input)).toEqual({
        ...emptyReport,
        findings: [{ rule: 'needs-rfc', verdict: 'BLOCKED', text: 'Issue #991 needs an Accepted or In delivery RFC.' }],
        forReviewer: [expect.stringContaining('#991')],
      });
    }
    // Inline code is stripped within one line only, so a span wrapped across lines leaves its text visible: the
    // checker over-reads a reference rather than hide one.
    expect(references('Example `wrapped\nFixes #991` then Refs #99.')).toEqual({ closing: [991], refs: [99] });
  });
});

describe('needs-rfc issues', () => {
  test('allows a code PR with Refs to a needs-rfc issue and an Accepted RFC', () => {
    expect(rfcChecks(delivery('Accepted, in delivery')).findings).toEqual([]);
    expect(rfcChecks(delivery())).toEqual(emptyReport);
  });

  test('requires acceptance on base even if the head row claims it', () => {
    const input = delivery();
    for (const baseReadme of [readme(), readme(indexRow(baseFile, 'Proposed'))]) {
      input.base.readme = baseReadme;
      expect(rfcChecks(input).findings).toContainEqual({
        rule: 'needs-rfc', verdict: 'BLOCKED', text: expect.stringMatching(/#20/),
      });
    }
    input.base.readme = readme(indexRow(baseFile, 'Accepted'));
    for (const headReadme of [readme(), readme(indexRow(baseFile, 'Proposed'))]) {
      input.head.readme = headReadme;
      expect(rfcChecks(input).findings).toEqual([]);
    }
  });

  test('counts only local qualified references and ignores a fenced closing example', () => {
    const input = snapshot();
    input.pr.files = [sourceFile];
    input.issues = [{ ...needsRfc, number: 991 }];
    input.pr.body = 'Fixes automagik-si/automagik#991';
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['needs-rfc']);
    expect(rfcChecks(input).forReviewer).toEqual([expect.stringContaining('#991')]);
    expect(references('Fixes Automagik-SI/AUTOMAGIK#991; Refs automagik-si/automagik#42', repo))
      .toEqual({ closing: [991], refs: [42] });
    input.pr.body = 'Fixes another-owner/automagik#991\n```\nFixes #991\n```';
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('blocks referenced needs-rfc issues without a named RFC', () => {
    const input = delivery();
    input.pr.title = 'A fix';
    input.pr.body = 'Fixes #20. Ref #3. Ref #2.';
    input.issues.push({ ...needsRfc, number: 3 }, { ...needsRfc, number: 2, labels: [] }, { ...needsRfc, number: 1 });
    expect(rfcChecks(input).findings.filter(finding => finding.verdict === 'BLOCKED').map(finding => finding.text)).toEqual([
      expect.stringMatching(/#3\b/), expect.stringMatching(/#20\b/),
    ]);
  });

  test('uses a body RFC for acceptance only when the title names no RFC', () => {
    const input = delivery();
    input.pr.title = 'A fix';
    input.pr.body = 'Fixes #20. RFC 0044 D2a.';
    input.head.readme = readme(indexRow(baseFile, 'Delivered'));
    expect(rfcChecks(input)).toEqual({
      ...emptyReport,
      forReviewer: [expect.stringMatching(/#20.*title names no RFC/)],
    });
    input.pr.title = 'RFC 0099 D2a';
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['closing-keyword', 'needs-rfc', 'rfc-delivery']);
  });

  test('exempts a docs/rfcs-only PR even if it references a needs-rfc issue', () => {
    const input = newRfc();
    input.pr.body = 'Refs #20';
    input.issues = [needsRfc];
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.pr.files.push({ path: 'docs/other.md', status: 'modified' });
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['needs-rfc']);
  });

  test('counts the source of a rename when deciding whether all changes are under docs/rfcs', () => {
    const input = newRfc();
    input.pr.body = 'Refs #20';
    input.issues = [needsRfc];
    input.pr.files.push({ path: 'docs/rfcs/notes.md', status: 'renamed', previousPath: 'scripts/notes.ts' });
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['needs-rfc', 'rfc-docs-only']);
  });
});

describe('new RFCs and companions', () => {
  test('accepts the next RFC with its index row, Template header, and docs(rfcs) commits', () => {
    expect(rfcChecks(newRfc())).toEqual(emptyReport);
  });

  test('takes the first gap above the highest base file number and reports claims in number order', () => {
    const input = newRfc('0046-new.md');
    input.base.rfcFiles.push('0045-unindexed.md');
    input.openPrClaims = [{ pr: 13, rfcNumber: 49 }, { pr: 12, rfcNumber: 47 }, { pr: 11, rfcNumber: 46 }];
    expect(rfcChecks(input).findings).toEqual([{
      rule: 'rfc-number', verdict: 'FIX-FIRST', path: 'docs/rfcs/0046-new.md',
      text: 'Use RFC 0048 as the next free number. Open claims: PR #11 claims 0046, PR #12 claims 0047, PR #13 claims 0049.',
    }]);
    const next = newRfc('0048-new.md');
    next.base = input.base;
    next.openPrClaims = input.openPrClaims;
    expect(rfcChecks(next)).toEqual(emptyReport);
  });

  test.each(['docs/draft.md', 'docs/rfcs/0044-existing.md'])('checks a new RFC renumbered or renamed from %s', previousPath => {
    const input = newRfc('0099-new.md');
    const path = 'docs/rfcs/0099-new.md';
    input.pr.files = [{ path, status: 'renamed', previousPath }];
    input.head.readme = input.base.readme;
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'rfc-number', verdict: 'FIX-FIRST', path, text: 'Use RFC 0045 as the next free number.' },
      { rule: 'rfc-row', verdict: 'FIX-FIRST', path, text: expect.stringContaining('0099-new.md') },
    ]);
  });

  test('keeps a same-number RFC rename out of the proposal checks', () => {
    const input = snapshot();
    input.pr.files = [{ path: 'docs/rfcs/0044-renamed.md', status: 'renamed', previousPath: 'docs/rfcs/' + baseFile }];
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('assigns two new RFCs consecutive free numbers and rejects a duplicate', () => {
    const input = newRfc();
    input.openPrClaims = [{ pr: 1942, rfcNumber: 46 }];
    const setSecond = (file: string) => {
      const path = 'docs/rfcs/' + file;
      input.pr.files = [{ path, status: 'added' }, { path: newPath, status: 'added' }];
      input.head.files[path] = rfc(file.slice(0, 4));
      input.head.readme = readme(indexRow(baseFile, 'Accepted'), indexRow(newFile, 'Proposed'), indexRow(file, 'Proposed'));
      return path;
    };
    setSecond('0047-second.md');
    expect(rfcChecks(input)).toEqual(emptyReport);
    const duplicate = setSecond('0045-second.md');
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'rfc-number', verdict: 'FIX-FIRST', path: duplicate, text: 'This PR adds more than one RFC numbered 0045.' },
      { rule: 'rfc-row', verdict: 'FIX-FIRST', path: 'docs/rfcs/README.md', text: 'RFC 0045 has two index rows.' },
    ]);
  });

  test('requires an index row that links the actual new file', () => {
    const input = newRfc();
    input.head.readme = readme(indexRow('0045-wrong.md', 'Proposed'));
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'rfc-row', verdict: 'FIX-FIRST', path: newPath, text: expect.stringMatching(/0045-new\.md/) },
    ]);
  });

  test('requires matching status words and reads the vocabulary from the base README', () => {
    const input = newRfc(newFile, 'Accepted, in delivery');
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['rfc-status']);
    input.head.files[newPath] = rfc('0045', 'Accepted (scheduled)');
    expect(rfcChecks(input)).toEqual(emptyReport);

    input.head.readme = readme(indexRow(baseFile, 'Accepted'), indexRow(newFile, 'Active')).replace('| Proposed |', '| Active |');
    input.head.files[newPath] = rfc('0045', 'Active');
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['rfc-status']);
    input.base.readme = input.base.readme.replace('| Proposed |', '| Active |');
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('reports bad headings, missing fields, field order, and invalid Created dates', () => {
    const input = newRfc();
    const original = input.head.files[newPath];
    for (const [contents, field] of [
      [original.replace('RFC 0045: Example', 'RFC 0046: Example'), '# RFC 0045'],
      [original.replace('\n| Milestone | not scheduled |', ''), 'Milestone'],
      [original.replace('| Milestone | not scheduled |\n| Lanes | plugin (3.N.P) |',
        '| Lanes | plugin (3.N.P) |\n| Milestone | not scheduled |'), 'Lanes'],
      [original.replace('2026-11-21', '2026-02-30'), 'Created'],
      [original.replace('| Field | Value |', '| Field | Text |'), 'Field/Value'],
    ]) {
      input.head.files[newPath] = contents;
      expect(rfcChecks(input).findings.filter(finding => finding.rule === 'rfc-header').some(finding => finding.text.includes(field)))
        .toBe(true);
    }
  });

  test('flags files outside docs and any non-RFC commit in a new RFC PR', () => {
    const input = newRfc();
    input.pr.files.push(sourceFile);
    input.pr.commits.push('docs(rfcs): ', 'fix(scripts): make a fix');
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['rfc-commits', 'rfc-docs-only']);
  });

  test('accepts 0016’s real companion without its own index row and requires a link to a base RFC', () => {
    const input = snapshot();
    const file = '0016-windows-handoff.md';
    const path = 'docs/rfcs/' + file;
    input.base = { rfcFiles: ['0016-windows-wslc.md'], readme: realReadme };
    input.head = { readme: realReadme, files: { [path]: readFileSync(join(rfcDir, file), 'utf8') } };
    input.pr.files = [{ path, status: 'added' }];
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.head.files[path] = input.head.files[path].replaceAll('(0016-windows-wslc.md)', '(0016-other.md)');
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'rfc-companion', verdict: 'FIX-FIRST', path, text: expect.stringMatching(/0016/) },
    ]);
  });
});

describe('delivery names and index rows', () => {
  test('requires a named delivery and drafts both follow-ups for an unchanged Accepted row', () => {
    const input = delivery('Accepted');
    input.pr.title = 'RFC 44';
    expect(rfcChecks(input)).toEqual({
      ...emptyReport,
      findings: [{ rule: 'rfc-delivery', verdict: 'FIX-FIRST', text: expect.stringMatching(/Name the RFC delivery/) }],
      followUps: [
        { rule: 'rfc-delivery-row', text: "Move RFC 0044's row." },
        { rule: 'rfc-delivery-row', text: 'Move RFC 0044 to In delivery.' },
      ],
    });
    input.pr.body += '\nRFC 0044 delivery 2';
    expect(rfcChecks(input).findings.map(finding => finding.text)).toEqual(['Name the RFC delivery in the PR title.']);
    input.pr.title = 'RFC 0044 delivery 2';
    expect(rfcChecks(input).findings).toEqual([]);
  });

  test('drafts the Accepted transition even when a milestone edit moves the row', () => {
    const input = delivery('Accepted');
    input.head.readme = input.base.readme.replace('not scheduled', 'Milestone 1');
    expect(rfcChecks(input)).toEqual({
      ...emptyReport, followUps: [{ rule: 'rfc-delivery-row', text: 'Move RFC 0044 to In delivery.' }],
    });
    input.head.readme = input.head.readme.replace('| Accepted | Milestone 1 |', '| In delivery | Milestone 1 |');
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('drafts a row update for an unchanged in-delivery row, but a changed row passes', () => {
    const input = delivery();
    input.base.readme = input.head.readme;
    expect(rfcChecks(input).followUps).toEqual([{ rule: 'rfc-delivery-row', text: "Move RFC 0044's row." }]);
    input.head.readme = readme(indexRow(baseFile, 'In delivery (D2a)'));
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.head.readme = readme();
    expect(rfcChecks(input).followUps).toHaveLength(1);
  });

  test('accepts #1855’s RFC 0002 3c and flags an unindexed delivery claim on a code PR', () => {
    const input = snapshot();
    const file = '0002-browser-group-1-completion.md';
    input.pr.title = "feat(bots-dsh): sign-ins stay in the browser's own storage, no cookies.json (RFC 0002 3c)";
    input.pr.files = [{ path: 'apps/bots-dsh/src/host/browser/session.js', status: 'modified' }];
    input.base = { rfcFiles: [file], readme: readme(indexRow(file, 'In delivery (3a landed)')) };
    input.head.readme = realReadme;
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.pr.title = 'RFC 0099 D5a';
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'rfc-delivery', verdict: 'FIX-FIRST', text: 'RFC 0099 is not in the index.' },
    ]);
    input.pr.files = [{ path: 'docs/example.md', status: 'modified' }];
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test.each([
    ['feat(bots-dsh): the machine reservation record and the check (RFC 0024 R4) (#1834)', '0024-automagik-cloud.md'],
    ['feat(bots-dsh): the role shop and the package picker (RFC 0037 P3) (#1828)', '0037-roles-not-types.md'],
  ])('recognizes the delivery ID in %s', (title, file) => {
    const input = snapshot();
    input.pr.title = title;
    input.pr.files = [sourceFile];
    input.base = { rfcFiles: [file], readme: readme(indexRow(file, 'Accepted')) };
    input.head.readme = readme(indexRow(file, 'In delivery'));
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('treats #1913’s mention of RFC 0043 D2 (#1914) as background', () => {
    const input = snapshot();
    const file = '0043-accounts-across-linked-machines.md';
    input.pr.title = "feat(am): point native workers at the panel's Bot login generation (#1509) (#1913)";
    input.pr.body = 'Replayed onto dev with RFC 0043 D2 (#1914) and #1208 (#1918), combined.\n\nRefs #1509';
    input.pr.files = [sourceFile];
    input.base = { rfcFiles: [file], readme: readme(indexRow(file, 'Accepted, in delivery')) };
    input.head.readme = input.base.readme;
    expect(rfcChecks(input)).toEqual(emptyReport);
  });
});

describe('release lane', () => {
  test.each([
    ['0021-meter-attribution.md', 'herdr', 'none here (docs); herdr (3.N.P) for ledger rows'],
    ['0041-web-self-update.md', 'full', 'nothing here builds the desktop app'],
  ])('echoes the %s shipping result with the RFC’s real free-text Lanes field', (file, kind, wording) => {
    const input = snapshot();
    const number = file.slice(0, 4);
    input.pr.title = 'RFC ' + number;
    input.base = { rfcFiles: [file], readme: realReadme };
    const contents = readFileSync(join(rfcDir, file), 'utf8');
    expect(parseHeader(contents).fields.find(field => field.name === 'Lanes')?.value).toContain(wording);
    input.head = { readme: realReadme, files: { ['docs/rfcs/' + file]: contents } };
    input.lane = { ships: true, kind };
    expect(rfcChecks(input)).toEqual({ ...emptyReport, lane: input.lane });
    input.lane = { ships: true, kind: 'pocket' };
    expect(rfcChecks(input)).toEqual({ ...emptyReport, lane: input.lane });
  });

  test('reports an unknown shipping result or kind and skips kind for non-shipping changes', () => {
    const input = delivery();
    for (const lane of [{ ships: null, kind: 'full' }, { ships: true, kind: null }]) {
      input.lane = lane;
      expect(rfcChecks(input)).toEqual({
        ...emptyReport, lane, findings: [{ rule: 'lane', verdict: 'FIX-FIRST', text: 'lane unknown' }],
      });
    }
    input.lane = { ships: false, kind: 'full' };
    expect(rfcChecks(input)).toEqual({ ...emptyReport, lane: input.lane });
  });
});

describe('closing keywords', () => {
  test.each(['in part', 'Part 2a', 'partial'])('uses Refs for %s work and reports only closing keywords', phrase => {
    const input = snapshot();
    input.pr.title = 'Do the work ' + phrase;
    input.pr.body = 'Fixes #11, fixed #2, RESOLVES #3, Refs #4, and Fixes #11.';
    expect(rfcChecks(input).findings.map(finding => [finding.rule, finding.text])).toEqual([
      ['closing-keyword', expect.stringContaining('Refs #2')],
      ['closing-keyword', expect.stringContaining('Refs #3')],
      ['closing-keyword', expect.stringContaining('Refs #11')],
    ]);
    input.pr.title = '';
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('accepts a final delivery that moves the base row from In delivery to Delivered', () => {
    const input = delivery();
    input.base.readme = input.head.readme;
    input.pr.body = 'Fixes #20';
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'closing-keyword', verdict: 'FIX-FIRST', text: 'Say Refs #20 until the last delivery.' },
    ]);
    input.head.readme = readme(indexRow(baseFile, 'Delivered'));
    expect(rfcChecks(input)).toEqual(emptyReport);
  });

  test('allows #1054’s partial log coverage and scopes body evidence to the closing line', () => {
    const input = snapshot();
    input.pr.title = 'feat(meter): count api_error (failed model calls) in usagemeter outcomes';
    input.pr.files = [{ path: 'meter/usagemeter/src/sources/claude.rs', status: 'modified' }];
    input.pr.body = 'Track api_errors_from_ms, api_errors_through_ms and api_errors_files in meta\n' +
      'so stores upgraded from #1027 keep tool_error full while marking api_error\n' +
      'not_recorded before sync and partial after sync on already-read logs.\n\nFixes #1026\nRefs #899';
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.pr.body = 'Fixes #12. Refs #13 (in part).\nFixes #14 (in part). Fixes #15.\nPart 2 of the work fixes #16.\nFixes #17 (partial).';
    const report = rfcChecks(input);
    expect(report.findings.map(finding => finding.text)).toEqual([expect.stringContaining('Say Refs #16.')]);
    expect(report.forReviewer).toEqual([expect.stringMatching(/#12.*#13/), expect.stringMatching(/#14.*#15/)]);
  });

  test('asks the Reviewer which closure a shared line’s partial marker qualifies', () => {
    const input = snapshot();
    input.pr.body = 'Fixes #12 and in part fixes #13.';
    expect(rfcChecks(input)).toEqual({ ...emptyReport, forReviewer: [expect.stringMatching(/#12.*#13/)] });
  });

  test('requires completion of every explicitly delivered RFC and ignores background RFCs', () => {
    const input = snapshot();
    const primary = '0029-pr-reviewer-bot.md';
    const background = '0020-unfold-plugins-leave.md';
    input.base = { rfcFiles: [primary, background], readme: realReadme };
    input.head.readme = realReadme;
    input.pr.title = 'RFC 0029 D3a';
    input.pr.body = 'Fixes #991. See RFC 0020 for background.';
    input.pr.files = [sourceFile];
    input.issues = [{ ...needsRfc, number: 991 }];
    const incomplete = { rule: 'closing-keyword', verdict: 'FIX-FIRST', text: 'Say Refs #991 until the last delivery.' };
    expect(rfcChecks(input).findings).toEqual([incomplete]);
    expect(rfcChecks(input).followUps).toEqual([{ rule: 'rfc-delivery-row', text: "Move RFC 0029's row." }]);

    input.head.readme = readme(indexRow(primary, 'Delivered'), indexRow(background, 'In delivery'));
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.pr.body = 'Fixes #991.\nAlso delivers RFC 0020 part 2.';
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.pr.title = 'RFC 0029 D3a and RFC 0020 D2';
    expect(rfcChecks(input).findings).toEqual([incomplete]);
    input.head.readme = readme(indexRow(primary, 'Delivered'), indexRow(background, 'Delivered'));
    expect(rfcChecks(input).findings).toEqual([]);

    input.pr.title = 'RFC 0029';
    input.pr.body = 'Fixes #991. Also names RFC 0020.';
    input.head.readme = readme(indexRow(primary, 'Delivered'), indexRow(background, 'In delivery'));
    expect(rfcChecks(input).findings).toEqual([
      { rule: 'rfc-delivery', verdict: 'FIX-FIRST', text: 'Name the RFC delivery in the PR title.' },
    ]);

    input.pr.title = 'RFC 0099 D3a';
    input.pr.body = 'Refs #991. See RFC 0029 for background.';
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toEqual(['needs-rfc', 'rfc-delivery']);
  });

  test('requires a Reviewer decision per issue when a final delivery closes two needs-rfc issues', () => {
    const input = delivery();
    input.base.readme = input.head.readme;
    input.head.readme = readme(indexRow(baseFile, 'Delivered'), indexRow('0043-other.md', 'In delivery'));
    input.pr.body = 'Fixes #20';
    expect(rfcChecks(input)).toEqual(emptyReport);
    input.pr.body += '\nFixes #42';
    input.issues.push({ ...needsRfc, number: 42 });
    expect(rfcChecks(input)).toEqual({
      ...emptyReport,
      forReviewer: [expect.stringMatching(/#20.*multiple needs-rfc/), expect.stringMatching(/#42.*multiple needs-rfc/)],
    });
  });

  test.each(['base', 'head'] as const)('treats RFC 0029’s status as unknown with a duplicate %s row', side => {
    const input = snapshot();
    const file = '0029-pr-reviewer-bot.md';
    input.pr = { ...input.pr, title: 'RFC 0029 D3a', body: 'Fixes #991', files: [sourceFile, { path: 'docs/rfcs/README.md', status: 'modified' }] };
    input.issues = [{ ...needsRfc, number: 991 }];
    input.base = { rfcFiles: [file], readme: readme(indexRow(file, 'In delivery')) };
    input.head.readme = readme(indexRow(file, 'Delivered'));
    expect(rfcChecks(input)).toEqual(emptyReport);
    input[side].readme = readme(indexRow(file, 'In delivery'), indexRow(file, 'Delivered'));
    expect(rfcChecks(input)).toEqual({
      ...emptyReport,
      findings: [
        { rule: 'closing-keyword', verdict: 'FIX-FIRST', text: 'Say Refs #991 until the last delivery.' },
        { rule: 'needs-rfc', verdict: 'BLOCKED', text: 'Issue #991 needs an Accepted or In delivery RFC.' },
        { rule: 'rfc-row', verdict: 'FIX-FIRST', path: 'docs/rfcs/README.md', text: 'RFC 0029 has two index rows.' },
      ],
    });
  });
});

describe('snapshot validation and ordering', () => {
  test('identifies unknown, missing, and invalid fields at every snapshot level', () => {
    const input = snapshot();
    for (const [bad, field] of [
      [{ ...input, unknown: 1 }, 'input.unknown'],
      [{ ...input, repo: null }, 'input.repo'],
      [{ ...input, pr: { ...input.pr, extra: true } }, 'input.pr.extra'],
      [{ ...input, pr: { ...input.pr, files: [{ ...sourceFile, unknown: true }] } }, 'input.pr.files[0].unknown'],
      [{ ...input, base: { ...input.base, extra: true } }, 'input.base.extra'],
      [{ ...input, head: { ...input.head, extra: true } }, 'input.head.extra'],
      [{ ...input, head: { ...input.head, files: { [newPath]: null } } }, 'input.head.files["' + newPath + '"]'],
      [{ ...input, openPrClaims: [{ rfcNumber: 45 }] }, 'input.openPrClaims[0].pr'],
      [{ ...input, issues: [{ ...needsRfc, state: 'unknown' }] }, 'input.issues[0].state'],
      [{ ...input, lane: { ...input.lane, kind: 'toString' } }, 'input.lane.kind'],
      [{ ...input, lane: { ...input.lane, ships: 'true' } }, 'input.lane.ships'],
    ] as const) {
      expect(() => rfcChecks(bad)).toThrow(field);
    }
  });

  test('sorts findings by rule and path or numeric issue, regardless of snapshot order', () => {
    const input = snapshot();
    input.pr.title = 'Partial fix';
    input.pr.body = 'Fixes #12. Fixes #2.';
    input.pr.files = [
      { path: 'docs/rfcs/0044-z-companion.md', status: 'added' },
      sourceFile,
      { path: 'docs/rfcs/0044-a-companion.md', status: 'added' },
    ];
    input.issues = [{ ...needsRfc, number: 12 }, { ...needsRfc, number: 2 }];
    const report = rfcChecks(input);
    expect(report.findings.map(finding => [finding.rule, finding.path ?? finding.text.match(/#\d+/)?.[0]])).toEqual([
      ['closing-keyword', '#2'], ['closing-keyword', '#12'],
      ['needs-rfc', '#2'], ['needs-rfc', '#12'],
      ['rfc-companion', 'docs/rfcs/0044-a-companion.md'], ['rfc-companion', 'docs/rfcs/0044-z-companion.md'],
    ]);
    input.pr.files.reverse();
    input.issues.reverse();
    expect(rfcChecks(input)).toEqual(report);
  });
});

describe('Astra round 3 regressions (Opus)', () => {
  test('counts a second index row the table parser cannot read as a duplicate', () => {
    const input = delivery('Delivered');
    input.pr = { ...input.pr, body: 'Fixes #20' };
    input.head.readme = readme(indexRow(baseFile, 'Delivered')) + '| [0044](0044-existing.md) | Example | In delivery | not scheduled\n';
    const result = rfcChecks(input);
    expect(result.findings).toContainEqual(
      { rule: 'rfc-row', verdict: 'FIX-FIRST', text: 'RFC 0044 has two index rows.', path: 'docs/rfcs/README.md' });
    expect(result.findings.some(finding => finding.rule === 'needs-rfc' || finding.rule === 'closing-keyword')).toBe(true);
  });

  test('keeps a closure visible between list items with unmatched backticks', () => {
    expect(references('- one ` tick\n- Fixes #991\n- another ` tick', repo).closing).toEqual([991]);
    expect(references('Use `Fixes #5` as an example.', repo).closing).toEqual([]);
  });

  test('reads a reference list wrapped after a comma', () => {
    expect(references('Refs #12,\n#991 and\n#7', repo).refs).toEqual([12, 991, 7]);
  });

  test('asks the Reviewer when several needs-rfc issues name RFCs in mixed states', () => {
    const input = delivery();
    input.pr = { ...input.pr, title: 'RFC 44 D3a and RFC 45 D1', body: 'Refs #20, #42' };
    input.issues = [needsRfc, { number: 42, labels: ['needs-rfc'], state: 'open' }];
    const result = rfcChecks(input);
    expect(result.findings.filter(finding => finding.rule === 'needs-rfc')).toEqual([]);
    expect(result.forReviewer.filter(line => line.includes('mixed states'))).toHaveLength(2);
  });

  test('defers a bare unindexed RFC citation such as #1388’s RFC 8252 to the Reviewer', () => {
    const input = snapshot();
    input.pr = { ...input.pr, title: 'feat(cloud): RFC 8252 system-browser sign-in', files: [sourceFile] };
    const result = rfcChecks(input);
    expect(result.findings.filter(finding => finding.rule === 'rfc-delivery')).toEqual([]);
    expect(result.forReviewer.some(line => line.includes('RFC 8252'))).toBe(true);
  });

  test('accepts #187’s "deliveries 1-2" and #854’s "step 5" as delivery ids', () => {
    expect(namedDelivery('feat: RFC 0003 deliveries 1-2', '')).toBe(true);
    expect(namedDelivery('feat: RFC 0020 step 5', '')).toBe(true);
  });

  test('treats #1048’s package README and RFC edit as documentation, not a delivery', () => {
    const input = snapshot();
    input.pr = { ...input.pr, title: 'docs: RFC 0044 notes', files: [
      { path: 'apps/acp-dsh/README.md', status: 'modified' }, { path: 'docs/rfcs/' + baseFile, status: 'modified' }] };
    expect(rfcChecks(input).findings.filter(finding => finding.rule === 'rfc-delivery')).toEqual([]);
    expect(rfcChecks(input).followUps).toEqual([]);
  });

  test('does not accept a companion link hidden in an HTML comment', () => {
    const input = snapshot();
    const path = 'docs/rfcs/0044-handoff.md';
    input.pr = { ...input.pr, title: 'docs(rfcs): handoff', files: [{ path, status: 'added' }] };
    input.head.files = { [path]: '# RFC 0044 handoff\n\n<!-- see [it](0044-existing.md) -->\n' };
    expect(rfcChecks(input).findings.map(finding => finding.rule)).toContain('rfc-companion');
  });
});
