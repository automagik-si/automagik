/** RFC 0029 D3a part 1: test review composition, refusals, and verdict parsing. */
import { describe, expect, test } from 'bun:test';
import { parseVerdictLine, verdictLine } from './rules';
import { composeCarry, composeVerdict } from './verdict';

const sha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const command = 'bun test scripts/pr-reviewer';
const codeProof = { type: 'text', command, output: '14 pass, 0 fail' };
const imageProof = { type: 'image', ref: 'https://example.com/proof/screenshot.png' };
const runProof = {
  type: 'run', command, output: 'Changed-path check passed.',
  ref: 'https://github.com/example/repo/actions/runs/108',
};
const dogfooder = {
  sha, verdict: 'SHIP', gate: 'scripts/capped-run -- bun test scripts/pr-reviewer',
  tests: '14 pass, 0 fail', mutant: 'Allow carry with failed CI', proof: codeProof,
};
const docsShip = {
  kind: 'SHIP', sha, docsOnly: true, passes: { reviewer: { sha, verdict: 'SHIP', notes: 'Checked RFC 0029.' } },
  findings: [], rfcLines: ['Delivery named: RFC 0029 D3a part 1.'], gates: ['CI result: success'],
};
const codeShip = { ...docsShip, docsOnly: false, passes: { ...docsShip.passes, dogfooder } };
const finding = { n: 1, path: 'scripts/pr-reviewer/poll.ts', line: 42, text: 'Require green CI.', inline: true };
const fixFirst = {
  ...docsShip, kind: 'FIX-FIRST', passes: { reviewer: { sha, verdict: 'FIX-FIRST' } }, findings: [finding],
};
const blocked = {
  ...docsShip, kind: 'BLOCKED', passes: { reviewer: { sha, verdict: 'BLOCKED' } },
  decision: 'Owner ruling on the missing carry evidence.',
};

describe('review composition', () => {
  test('approves docs with a single Reviewer pass and renders the required sections', () => {
    const result = composeVerdict(docsShip);
    expect(result).toEqual({
      body: [
        verdictLine('SHIP', sha),
        '## Passes\n\n- Reviewer: SHIP\nChecked RFC 0029.',
        '## Findings\n\nNone.',
        '## RFC system\n\nDelivery named: RFC 0029 D3a part 1.',
        '## Gates\n\nCI result: success',
      ].join('\n\n'),
      event: 'APPROVE', labels: [], comments: [],
    });
    expect(parseVerdictLine(result.body)).toEqual({ kind: 'SHIP', sha });
  });

  for (const proof of [codeProof, imageProof, runProof]) {
    test('approves code with both passes and ' + proof.type + ' proof', () => {
      const result = composeVerdict({ ...codeShip, passes: { ...codeShip.passes, dogfooder: { ...dogfooder, proof } } });
      expect(result.event).toBe('APPROVE');
      expect(result.labels).toEqual([]);
      expect(result.comments).toEqual([]);
      expect(result.body).toContain('Reviewer: SHIP');
      expect(result.body).toContain('Dogfooder: SHIP');
      expect(result.body).toContain(dogfooder.gate);
      expect(result.body).toContain(dogfooder.tests);
      expect(result.body).toContain(dogfooder.mutant);
      expect(result.body).toContain('Proof (' + proof.type + '):');
      if ('ref' in proof) expect(result.body).toContain(proof.ref);
      if ('command' in proof) expect(result.body).toContain(proof.command);
      if ('output' in proof) expect(result.body).toContain(proof.output);
      expect(parseVerdictLine(result.body)).toEqual({ kind: 'SHIP', sha });
    });
  }

  test('requests changes with exactly one inline comment per finding', () => {
    const findings = [
      finding,
      { n: 2, path: 'scripts/pr-reviewer/rules.ts', line: 17, text: 'Check the rule.', inline: false },
      { n: 3, path: 'docs/example.md', line: 1, text: 'Check the opening line.', inline: true },
    ];
    const result = composeVerdict({ ...fixFirst, findings });
    expect(result.event).toBe('REQUEST_CHANGES');
    expect(result.labels).toEqual([]);
    expect(result.comments).toHaveLength(findings.length);
    expect(result.comments).toEqual(findings.map(({ path, line, text }) => ({ path, line, body: text })));
    expect(result.body).toContain('1. `scripts/pr-reviewer/poll.ts:42` Require green CI.');
    expect(result.body).toContain('2. `scripts/pr-reviewer/rules.ts:17` Check the rule.');
    expect(result.body).toContain('3. `docs/example.md:1` Check the opening line.');
    expect(parseVerdictLine(result.body)).toEqual({ kind: 'FIX-FIRST', sha });
  });

  test('requests changes with the blocked label and names the decision', () => {
    const result = composeVerdict({ ...blocked, findings: [finding] });
    expect(result.event).toBe('REQUEST_CHANGES');
    expect(result.labels).toEqual(['blocked']);
    expect(result.comments).toEqual([]);
    expect(result.body).toContain('## Decision\n\n' + blocked.decision);
    expect(result.body).toContain(finding.text);
    expect(parseVerdictLine(result.body)).toEqual({ kind: 'BLOCKED', sha });
  });
});

describe('verdict refusals', () => {
  test('refuses SHIP with findings or a non-SHIP Reviewer', () => {
    expect(() => composeVerdict({ ...docsShip, findings: [finding] })).toThrow('input.findings');
    expect(() => composeVerdict({ ...docsShip, passes: fixFirst.passes })).toThrow('input.passes.reviewer.verdict');
  });

  test('refuses code SHIP without a SHIP Dogfooder verdict', () => {
    expect(() => composeVerdict({ ...docsShip, docsOnly: false })).toThrow('input.passes.dogfooder');
    expect(() => composeVerdict({
      ...codeShip, passes: { ...codeShip.passes, dogfooder: { ...dogfooder, verdict: 'BLOCKED' } },
    })).toThrow('input.passes.dogfooder.verdict');
  });

  for (const input of [fixFirst, blocked]) {
    test('requires a head-bound Dogfooder pass for code ' + input.kind, () => {
      const code = { ...input, docsOnly: false };
      expect(() => composeVerdict(code)).toThrow('input.passes.dogfooder is required');
      const { proof, ...evidence } = dogfooder;
      const withPass = { ...code, passes: { ...code.passes, dogfooder: { ...evidence, verdict: input.kind } } };
      const result = composeVerdict(withPass);
      expect(result.event).toBe('REQUEST_CHANGES');
      expect(result.body).toContain('Dogfooder: ' + input.kind);
      expect(result.body).not.toContain('Proof (');
      expect(() => composeVerdict({
        ...withPass, passes: { ...withPass.passes, dogfooder: { ...withPass.passes.dogfooder, sha: newSha } },
      })).toThrow('input.passes.dogfooder.sha must match input.sha');
      expect(() => composeVerdict({
        ...withPass, passes: { ...withPass.passes, dogfooder: evidence },
      })).toThrow('input.passes.dogfooder.proof is required');
    });
  }

  test('refuses to reuse the passes from head A to approve head B', () => {
    const moved = { ...codeShip, sha: newSha };
    expect(() => composeVerdict(moved)).toThrow('input.passes.reviewer.sha must match input.sha');
    expect(() => composeVerdict({
      ...moved, passes: { ...moved.passes, reviewer: { ...moved.passes.reviewer, sha: newSha } },
    })).toThrow('input.passes.dogfooder.sha must match input.sha');

    const dogfooderAtNewHead = { ...dogfooder, sha: newSha };
    expect(() => composeVerdict({
      ...moved, passes: { ...moved.passes, dogfooder: dogfooderAtNewHead },
    })).toThrow('input.passes.reviewer.sha must match input.sha');
  });

  for (const key of ['sha', 'gate', 'tests', 'mutant', 'proof'] as const) {
    test('refuses a Dogfooder pass with no ' + key, () => {
      const { [key]: omitted, ...partial } = dogfooder;
      expect(() => composeVerdict({ ...codeShip, passes: { ...codeShip.passes, dogfooder: partial } }))
        .toThrow('input.passes.dogfooder.' + key + ' is required');
    });
  }

  test('refuses malformed Dogfooder evidence', () => {
    for (const [changes, field] of [
      [{ gate: '' }, 'gate'],
      [{ tests: 14 }, 'tests'],
      [{ mutant: ' ' }, 'mutant'],
      [{ proof: null }, 'proof'],
      [{ proof: { ref: imageProof.ref } }, 'proof.type'],
      [{ proof: { type: 'video', ref: imageProof.ref } }, 'proof.type'],
      [{ proof: { ...imageProof, ref: 'proof/screenshot.png' } }, 'proof.ref'],
      [{ proof: { ...imageProof, ref: 'http://example.com/proof.png' } }, 'proof.ref'],
      [{ proof: { type: 'text', command } }, 'proof.output'],
      [{ proof: { type: 'text', output: codeProof.output } }, 'proof.command'],
      [{ proof: { ...codeProof, output: ' ' } }, 'proof.output'],
      [{ proof: { ...runProof, ref: 'CI run 108' } }, 'proof.ref'],
      [{ proof: { ...runProof, ref: 'https://github.com/example/repo/actions' } }, 'proof.ref'],
      [{ proof: { ...runProof, ref: 'https://github.com.example.com/example/repo/actions/runs/108' } }, 'proof.ref'],
      [{ proof: { type: 'run', ref: runProof.ref, output: runProof.output } }, 'proof.command'],
      [{ proof: { type: 'run', ref: runProof.ref, command } }, 'proof.output'],
      [{ proof: { ...runProof, output: ' ' } }, 'proof.output'],
      [{ proof: { ...runProof, ref: runProof.ref.replace('https:', 'http:') } }, 'proof.ref'],
    ] as const) {
      expect(() => composeVerdict({
        ...codeShip, passes: { ...codeShip.passes, dogfooder: { ...dogfooder, ...changes } },
      })).toThrow('input.passes.dogfooder.' + field);
    }
  });

  test('refuses FIX-FIRST findings without a path or line', () => {
    const findingWithoutPath = { n: 1, line: 42, text: finding.text, inline: false };
    const findingWithoutLine = { n: 1, path: finding.path, text: finding.text, inline: true };
    expect(() => composeVerdict({ ...fixFirst, findings: [findingWithoutPath] })).toThrow('input.findings[0].path');
    expect(() => composeVerdict({ ...fixFirst, findings: [findingWithoutLine] })).toThrow('input.findings[0].line');
  });

  test('requires a finding for FIX-FIRST and a nonempty decision for BLOCKED', () => {
    expect(() => composeVerdict({ ...fixFirst, findings: [] })).toThrow('input.findings');
    const { decision, ...undecided } = blocked;
    expect(() => composeVerdict(undecided)).toThrow('input.decision');
    expect(() => composeVerdict({ ...blocked, decision: ' ' })).toThrow('input.decision');
  });

  test('names unexpected, missing and malformed input fields', () => {
    for (const [changes, field] of [
      [{ kind: 'APPROVE' }, 'kind'],
      [{ sha: 'abc' }, 'sha'],
      [{ sha: null }, 'sha'],
      [{ docsOnly: 1 }, 'docsOnly'],
      [{ extra: true }, 'extra'],
      [{ passes: {} }, 'passes.reviewer'],
      [{ passes: { reviewer: { verdict: 'SHIP' } } }, 'passes.reviewer.sha'],
      [{ passes: { reviewer: { sha, verdict: 'UNKNOWN' } } }, 'passes.reviewer.verdict'],
      [{ passes: { reviewer: { sha, verdict: 'SHIP', notes: [] } } }, 'passes.reviewer.notes'],
      [{ findings: null }, 'findings'],
      [{ rfcLines: [false] }, 'rfcLines[0]'],
      [{ gates: 'CI' }, 'gates'],
    ] as const) {
      expect(() => composeVerdict({ ...docsShip, ...changes })).toThrow('input.' + field);
    }
  });

  test('names invalid finding fields and duplicate finding numbers', () => {
    for (const [changes, field] of [
      [{ n: 0 }, 'n'],
      [{ path: '' }, 'path'],
      [{ line: 1.5 }, 'line'],
      [{ text: ' ' }, 'text'],
      [{ inline: 'true' }, 'inline'],
    ] as const) {
      expect(() => composeVerdict({ ...fixFirst, findings: [{ ...finding, ...changes }] }))
        .toThrow('input.findings[0].' + field);
    }
    expect(() => composeVerdict({ ...fixFirst, findings: [finding, finding] })).toThrow('input.findings[1].n');
  });
});

describe('carry review', () => {
  const carry = { kind: 'SHIP', from: sha, to: newSha };

  test('binds SHIP to the new SHA and names the old SHA and the carry evidence', () => {
    const body = composeCarry(carry);
    expect(body.split('\n', 1)[0]).toBe(verdictLine('SHIP', newSha));
    expect(body).toContain('carried from ' + sha + ": the PR's own diff is unchanged; dev merged in, CI green");
    expect(parseVerdictLine(body)).toEqual({ kind: 'SHIP', sha: newSha });
  });

  test('refuses non-SHIP, invalid heads or unknown fields', () => {
    expect(() => composeCarry({ ...carry, kind: 'FIX-FIRST' })).toThrow('carry.kind');
    expect(() => composeCarry({ ...carry, from: 'short' })).toThrow('carry.from');
    expect(() => composeCarry({ ...carry, to: newSha.toUpperCase().replace('B', 'Z') })).toThrow('carry.to');
    expect(() => composeCarry({ ...carry, proof: 'excess' })).toThrow('carry.proof');
  });
});
