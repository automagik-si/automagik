// One Node version for both jobs (#1645). The release cut and CI's herdr/am gates must run the
// same Node: a Node minor can change filesystem, network or process behaviour, and 24.0-24.13.0's
// `rmSync` followed a symlink to a directory where 24.18 unlinked it, so a release on 24.9.0
// failed for hours while the same commit passed every PR check on 22 + latest 24 (#1645, the tests
// fixed by #1644). Both workflows read .github/node-versions.json, and this test is what keeps the
// file, the CI matrix and the release pin from drifting apart again.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(REPO, path), 'utf8');
const workflow = (name: string) => Bun.YAML.parse(read(`.github/workflows/${name}`)) as any;

const file = JSON.parse(read('.github/node-versions.json'));
const ci = workflow('ci.yml');
const release = workflow('release.yml');

/** An exact version (`24.9.0`), never a floating `24` or `24.9` a release could drift from. */
const EXACT = /^\d+\.\d+\.\d+$/;
/** A matrix leg: exact, or a major (`22`) whose newest release is the test floor. */
const LEG = /^\d+(\.\d+){0,2}$/;

const setupNodes = (job: any): any[] =>
  (job.steps ?? []).filter((step: any) => String(step.uses ?? '').startsWith('actions/setup-node'));

describe('the one Node versions file', () => {
  test('lists distinct versions, and the release pin is one of them, exactly', () => {
    expect(Array.isArray(file.ci)).toBe(true);
    expect(file.ci.length).toBeGreaterThan(0);
    for (const leg of file.ci) expect(leg).toMatch(LEG);
    expect(new Set(file.ci).size).toBe(file.ci.length);
    // A floating release pin is the skew itself: it resolves to a different minor over time.
    expect(file.release).toMatch(EXACT);
    expect(file.ci).toContain(file.release);
  });
});

describe('the CI matrix', () => {
  test('herdr and am read their versions from the file, through a job of its own', () => {
    for (const id of ['herdr', 'am']) {
      const job = ci.jobs[id];
      const needs = [job.needs].flat();
      expect(needs).toContain('changes');
      expect(needs).toContain('nodes');
      // The matrix is the file's `ci` list, not a second literal set in the workflow.
      expect(job.strategy.matrix.node).toBe('${{ fromJSON(needs.nodes.outputs.matrix) }}');
    }
    const nodes = ci.jobs.nodes;
    expect(nodes.outputs.matrix).toBe('${{ steps.read.outputs.matrix }}');
    const step = (nodes.steps as any[]).find((candidate) => candidate.id === 'read');
    expect(step.run).toContain("jq -c '.ci' .github/node-versions.json");
    // It cannot be gated on `changes`: a failed detection must still run every area (#895).
    expect(nodes.needs).toBeUndefined();
    expect(nodes.if).toBeUndefined();
  });
});

describe('the release cut', () => {
  test('runs the exact version the CI matrix covers, read from the same file', () => {
    const cut = release.jobs.cut;
    const readStep = (cut.steps as any[]).find((step) => step.id === 'node');
    expect(readStep).toBeDefined();
    expect(readStep.run).toContain("jq -r '.release' .github/node-versions.json");
    // It refuses a pin that is floating or missing from the matrix instead of running it.
    expect(readStep.run).toContain("'.ci | index($version)'");

    const setup = setupNodes(cut);
    expect(setup).toHaveLength(1);
    expect(setup[0].with['node-version']).toBe('${{ steps.node.outputs.version }}');
  });
});

describe('every other Node pin', () => {
  // Setup-node pins that are not expressions. An expression's source is checked in the two
  // blocks above (the matrix reads the file, the cut reads the file).
  function literalPins(): { where: string; version: string }[] {
    const pins: { where: string; version: string }[] = [];
    for (const [name, parsed] of [['ci.yml', ci], ['release.yml', release]] as const) {
      for (const [id, job] of Object.entries<any>(parsed.jobs)) {
        for (const step of setupNodes(job)) {
          const value = step.with?.['node-version'];
          if (value === undefined || String(value).includes('${{')) continue;
          pins.push({ where: `${name}:${id}`, version: String(value) });
        }
      }
    }
    return pins;
  }

  test('is a version the shared file lists', () => {
    const pins = literalPins();
    expect(pins.length).toBeGreaterThan(0);
    for (const { where, version } of pins) {
      expect(file.ci, `${where} pins Node ${version}, which .github/node-versions.json does not list`).toContain(version);
    }
  });

  test('is not hidden in a second literal matrix or a node-version key', () => {
    for (const name of ['ci.yml', 'release.yml']) {
      const text = read(`.github/workflows/${name}`);
      // A `node: ['22', ...]` matrix would be a second place by construction.
      expect(text).not.toMatch(/node:\s*\[/);
      for (const match of text.matchAll(/node-version:\s*(\S+)/g)) {
        const value = match[1].replace(/['"]/g, '');
        if (value.includes('${{')) continue;
        expect(file.ci, `${name} pins Node ${value} outside .github/node-versions.json`).toContain(value);
      }
    }
  });
});
