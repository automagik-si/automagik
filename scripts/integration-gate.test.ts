import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judge, loadManifest, renderSummary, validateManifest } from './integration-gate.mjs';

// The required-integration gate (#1175). Every run below is a real `node --test` run of small
// fixture files, judged from the runner's own events: a skipped, empty, cut-short or missing
// required file fails even while another file in the same run passes.
const GATE = join(import.meta.dir, 'integration-gate.mjs');
const REPO = join(import.meta.dir, '..');
const work = mkdtempSync(join(tmpdir(), 'integration-gate-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const ENV = 'INTEGRATION_GATE_TEST_PREREQ';
const JOB = 'fixture (required integration)';
const cases = (n: number, options = '') =>
  Array.from({ length: n }, (_, i) => `  await t.test('case ${i}', ${options}() => {})`).join('\n');
const parent = (body: string) => `import { test } from 'node:test'\ntest('parent', async t => {\n${body}\n})\n`;
const unit = `import { test } from 'node:test'\n${Array.from({ length: 7 }, (_, i) => `test('unit ${i}', () => {})`).join('\n')}\n`;

/** A fixture repository: scripts/integration-groups.json and test files under app/. */
function fixture(files: Record<string, string>, groupFiles = ['test/required.test.mjs'], expect = { tests: 7, pass: 7, top: 1 }) {
  const base = mkdtempSync(join(work, 'repo-'));
  mkdirSync(join(base, 'scripts'));
  mkdirSync(join(base, 'app', 'test'), { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(base, 'app', name), source);
  const manifest = {
    groups: [
      { id: 'fixture', cwd: 'app', files: groupFiles, env: [ENV], jobs: { [JOB]: 'required' }, expect },
      { id: 'later', cwd: 'app', files: ['test/later.test.mjs'], env: ['INTEGRATION_GATE_TEST_ABSENT'], jobs: { [JOB]: 'unprovisioned' }, note: 'needs a pinned adapter' },
    ],
  };
  const path = join(base, 'scripts', 'integration-groups.json');
  writeFileSync(path, JSON.stringify(manifest));
  return { base, path, out: join(base, 'out') };
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function gate(args: string[], env: Record<string, string | undefined> = { [ENV]: '1' }) {
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.NODE_TEST_CONTEXT;
  delete base.GITHUB_STEP_SUMMARY;
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...base, ...env })) if (value !== undefined) merged[key] = value;
  return spawnSync('node', [GATE, ...args], { cwd: work, encoding: 'utf8', env: merged, timeout: 60_000 });
}
const run = (fx: ReturnType<typeof fixture>, env?: Record<string, string | undefined>) =>
  gate(['run', 'fixture', '--out', fx.out, '--manifest', fx.path], env);
const verdict = (fx: ReturnType<typeof fixture>) => JSON.parse(readFileSync(join(fx.out, 'verdict.json'), 'utf8'));

describe('a required group, run for real', () => {
  test('positive control: seven executed passes in one parent pass the gate', () => {
    const fx = fixture({ 'test/required.test.mjs': parent(cases(6)) });
    const r = run(fx);
    expect(r.stderr).not.toContain('integration-gate:');
    expect(r.status).toBe(0);
    const v = verdict(fx);
    expect(v.ok).toBe(true);
    expect(v.counts).toEqual({ tests: 7, pass: 7, skip: 0, todo: 0, fail: 0, cancelled: 0, top: 1 });
    expect(v.files).toEqual([{ file: 'test/required.test.mjs', complete: true, counts: v.counts }]);
    expect(r.stdout).toContain('case 5');
    for (const name of ['ledger.jsonl', 'run.log', 'verdict.json']) expect(existsSync(join(fx.out, name))).toBe(true);
  });

  test('all skipped fails, even with Node exiting 0', () => {
    const fx = fixture({ 'test/required.test.mjs': `import { test } from 'node:test'\n${Array.from({ length: 7 }, (_, i) => `test('s${i}', { skip: 'no env' }, () => {})`).join('\n')}\n` }, undefined, { tests: 7, pass: 7, top: 7 });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('integration-gate: fixture: test/required.test.mjs: no executed tests');
    expect(r.stderr).toContain('expected skip 0, saw 7');
    expect(r.stderr).toContain('expected pass 7, saw 0');
  });

  test('one nested skip or todo fails', () => {
    for (const mode of ['skip', 'todo']) {
      const fx = fixture({ 'test/required.test.mjs': parent(`${cases(5)}\n  await t.test('odd', { ${mode}: true }, () => {})`) });
      const r = run(fx);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`expected ${mode} 0, saw 1`);
    }
  });

  test('an absent required environment variable fails before running, though the tests would pass', () => {
    const fx = fixture({ 'test/required.test.mjs': parent(cases(6)) });
    const r = run(fx, { [ENV]: undefined });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`integration-gate: fixture: missing prerequisites: ${ENV}`);
    expect(existsSync(join(fx.out, 'ledger.jsonl'))).toBe(false);
    const v = verdict(fx);
    expect(v.ok).toBe(false);
    expect(v.counts).toBeNull();
    // An empty value is as absent as an unset one.
    expect(run(fx, { [ENV]: '' }).status).toBe(1);
  });

  test('a different group passing does not mask a required file that was all skipped', () => {
    const fx = fixture({
      'test/unit.test.mjs': unit,
      'test/required.test.mjs': parent(cases(6, "{ skip: 'no env' }, ")),
    }, ['test/unit.test.mjs', 'test/required.test.mjs'], { tests: 14, pass: 14, top: 8 });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expected skip 0, saw 6');
  });

  test('passes from a file outside the group never count for it', () => {
    // The group names only required.test.mjs; the runner is handed exactly that file, so a
    // ledger that also carries unit.test.mjs is foreign evidence.
    const fx = fixture({ 'test/unit.test.mjs': unit, 'test/required.test.mjs': parent(cases(6)) });
    const lines = spawnSync('node', ['--test', `--test-reporter=${new URL('./integration-gate-reporter.mjs', import.meta.url).href}`,
      'test/unit.test.mjs', 'test/required.test.mjs'], { cwd: join(fx.base, 'app'), encoding: 'utf8', env: cleanEnv() }).stdout;
    const group = loadManifest(fx.path).groups[0];
    const result = judge(lines, group, fx.base);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p: string) => p.startsWith('unexpected event file:'))).toBe(true);
  });

  test('a required file missing from disk fails, naming it', () => {
    const fx = fixture({ 'test/unit.test.mjs': unit }, ['test/unit.test.mjs', 'test/required.test.mjs'], { tests: 14, pass: 14, top: 8 });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('test/required.test.mjs: test file missing under app');
  });

  test('an empty required file fails while another file passes', () => {
    const fx = fixture({ 'test/unit.test.mjs': unit, 'test/required.test.mjs': '' },
      ['test/unit.test.mjs', 'test/required.test.mjs'], { tests: 7, pass: 7, top: 7 });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('test/required.test.mjs: no end-of-file summary (empty, or exited before the end)');
  });

  test('a required file that exits before its end fails while another file passes', () => {
    const fx = fixture({
      'test/unit.test.mjs': unit,
      'test/required.test.mjs': parent(`${cases(3)}\n  process.exit(0)\n${cases(3)}`),
    }, ['test/unit.test.mjs', 'test/required.test.mjs'], { tests: 14, pass: 14, top: 8 });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('test/required.test.mjs: no end-of-file summary (empty, or exited before the end)');
    expect(verdict(fx).files.find((f: { file: string }) => f.file === 'test/required.test.mjs').complete).toBe(false);
  });

  test('a short pass count fails with both numbers', () => {
    const fx = fixture({ 'test/required.test.mjs': parent(cases(5)) });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expected pass 7, saw 6');
    expect(r.stderr).toContain('expected tests 7, saw 6');
  });

  test('a failing test fails the gate', () => {
    const fx = fixture({ 'test/required.test.mjs': parent(`${cases(5)}\n  await t.test('bad', () => { throw new Error('no') })`) });
    const r = run(fx);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('runner exit code 1');
  });

  test('a ledger with no results, or none at all, is no proof', () => {
    const group = { id: 'g', cwd: 'app', files: ['test/a.test.mjs'], env: [], jobs: { [JOB]: 'required' }, expect: { tests: 1, pass: 1, top: 1 } };
    for (const ledger of [undefined, '', 'not json\n']) {
      const result = judge(ledger as unknown as string, group, work);
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual(['no complete test results']);
      expect(result.counts).toBeNull();
    }
  });

  test('a group that is not required, or unknown, is refused', () => {
    const fx = fixture({ 'test/required.test.mjs': parent(cases(6)) });
    expect(gate(['run', 'later', '--out', fx.out, '--manifest', fx.path]).stderr).toContain('not a required group');
    expect(gate(['run', 'nope', '--out', fx.out, '--manifest', fx.path]).stderr).toContain('unknown group: nope');
  });
});

describe('the summary', () => {
  test('a required row shows executed and skipped apart, and links the results', () => {
    const fx = fixture({ 'test/required.test.mjs': parent(cases(6)) });
    expect(run(fx).status).toBe(0);
    const md = renderSummary(loadManifest(fx.path), JOB, verdict(fx), 'https://example.invalid/a/1', {});
    expect(md).toContain('| fixture | required | 7 | 7 | 0 | 0 | 0 | pass |');
    expect(md).toContain('[Integration results](https://example.invalid/a/1)');
  });

  test('a required row with no verdict reads unknown and FAIL, never zero', () => {
    const fx = fixture({});
    const md = renderSummary(loadManifest(fx.path), JOB, null, '', {});
    expect(md).toContain('| fixture | required | unknown | unknown | unknown | unknown | unknown | FAIL |');
  });

  test('an unprovisioned row reports the environment it observed and claims nothing', () => {
    const fx = fixture({});
    const absent = renderSummary(loadManifest(fx.path), JOB, null, '', {});
    expect(absent).toContain('| later | unprovisioned | unknown | unknown | unknown | unknown | unknown | not run here | INTEGRATION_GATE_TEST_ABSENT absent; uncovered in PR CI until provisioned, not claimed; needs a pinned adapter |');
    const present = renderSummary(loadManifest(fx.path), JOB, null, '', { INTEGRATION_GATE_TEST_ABSENT: 'x' });
    expect(present).toContain('INTEGRATION_GATE_TEST_ABSENT present');
  });

  test('the CLI appends to the step summary, and refuses a job in no group', () => {
    const fx = fixture({});
    const file = join(fx.base, 'summary.md');
    writeFileSync(file, 'before\n');
    const r = gate(['summary', '--job', JOB, '--manifest', fx.path], { GITHUB_STEP_SUMMARY: file });
    expect(r.status).toBe(0);
    expect(readFileSync(file, 'utf8')).toStartWith('before\n## Integration coverage: fixture (required integration)');
    expect(gate(['summary', '--job', 'no such job', '--manifest', fx.path]).status).toBe(1);
  });
});

describe('the manifest', () => {
  const required = { id: 'r', cwd: 'app', files: ['t.js'], env: [], jobs: { j: 'required' }, expect: { tests: 1, pass: 1, top: 1 } };
  test('rejects duplicates, unknown statuses, paths outside the repository and loose expectations', () => {
    for (const groups of [
      [required, required],
      [{ ...required, jobs: { j: 'maybe' } }],
      [{ ...required, cwd: '../elsewhere' }],
      [{ ...required, files: ['../../x.js'] }],
      [{ ...required, files: [] }],
      [{ ...required, expect: { tests: 2, pass: 1, top: 1 } }],
      [{ ...required, expect: { tests: 0, pass: 0, top: 0 } }],
      [{ ...required, expect: undefined }],
    ]) expect(() => validateManifest({ groups })).toThrow('invalid manifest');
    expect(validateManifest({ groups: [required] })).toBeTruthy();
  });
});

describe('the repository contract', () => {
  const manifest = loadManifest();
  const ci = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobNames = [...ci.matchAll(/^ {4}name: (.+)$/gm)].map((m) => m[1].trim());
  const pluginApps = ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'welcome-dsh'];
  const known = new Set(jobNames.flatMap((n) => n === '${{ matrix.app }} (plugin tests)' ? pluginApps.map((a) => `${a} (plugin tests)`) : [n]));

  test('every group names a job ci.yml has, and files that exist', () => {
    for (const group of manifest.groups) {
      for (const job of Object.keys(group.jobs)) expect(known.has(job)).toBe(true);
      for (const file of group.files) expect(existsSync(join(REPO, group.cwd, file))).toBe(true);
    }
  });

  test('each required group is run by its job, and that job keeps image-read-gate.mjs', () => {
    for (const group of manifest.groups) {
      for (const [job, status] of Object.entries(group.jobs)) {
        if (status !== 'required') continue;
        const start = ci.indexOf(`    name: ${job}\n`);
        expect(start).toBeGreaterThan(0);
        const next = ci.slice(start).search(/\n {2}[a-z][\w-]*:\n/);
        const body = ci.slice(start, next < 0 ? undefined : start + next);
        expect(body).toMatch(new RegExp(`integration-gate\\.mjs run ${group.id} \\\\?\\s*--out`));
        expect(body).toContain(`integration-gate.mjs summary`);
        expect(body).toContain(`--job "${job}"`);
        expect(body).toContain('actions/upload-artifact@');
        if (group.id === 'acp-image-read') expect(body).toContain('node scripts/image-read-gate.mjs\n');
      }
    }
  });

  test('acp-image-read expects exactly what image-read-gate.mjs expects', () => {
    const old = readFileSync(join(REPO, 'apps', 'acp-dsh', 'scripts', 'image-read-gate.mjs'), 'utf8');
    expect(old).toContain('const expected = { tests: 7, pass: 7, fail: 0, cancelled: 0, skipped: 0, todo: 0 }');
    expect(old).toContain("/^1\\.\\.1$/m");
    expect(manifest.groups.find((g: { id: string }) => g.id === 'acp-image-read').expect).toEqual({ tests: 7, pass: 7, top: 1 });
  });

  test('every acp-dsh test that reads AUTOMAGIK_TEST_ is classified', () => {
    // install-adapters.test.js only sets these variables for the child processes it starts.
    const childOnly = new Set(['install-adapters.test.js']);
    const listed = new Set(manifest.groups.filter((g: { cwd: string }) => g.cwd === 'apps/acp-dsh').flatMap((g: { files: string[] }) => g.files));
    const dir = join(REPO, 'apps', 'acp-dsh', 'test');
    const reading = readdirSync(dir).filter((f) => f.endsWith('.test.js') && /process\.env\.AUTOMAGIK_TEST_/.test(readFileSync(join(dir, f), 'utf8')));
    expect(reading.length).toBeGreaterThan(0);
    for (const file of reading) if (!childOnly.has(file)) expect(listed.has(`test/${file}`)).toBe(true);
    expect(readFileSync(join(dir, 'install-adapters.test.js'), 'utf8')).not.toMatch(/process\.env\.AUTOMAGIK_TEST_/);
  });

  test('the real-adapter selectors name tests that exist', () => {
    const source = readFileSync(join(REPO, 'apps', 'acp-dsh', 'test', 'real-adapters.test.js'), 'utf8');
    const agents = readFileSync(join(REPO, 'apps', 'acp-dsh', 'src', 'host', 'agents.js'), 'utf8');
    for (const group of manifest.groups.filter((g: { select?: string }) => g.select)) {
      // The file names its tests `real ${spec.defaultName}: ...`, one spec per adapter.
      expect(source).toContain('test(`real ${spec.defaultName}: ');
      const name = group.select.match(/^real (.+):$/)?.[1];
      expect(agents).toContain(`defaultName: '${name}',`);
    }
  });

  test('the plugin job only reports, it claims no coverage', () => {
    expect(ci).toContain('Integration groups (optional here, not claimed as coverage)');
    expect(ci).toContain(`if: \${{ matrix.app == 'acp-dsh' && !cancelled() }}`);
    const md = renderSummary(manifest, 'acp-dsh (plugin tests)', null, '', {});
    expect(md).not.toContain('| required |');
    expect(md).toContain('| acp-image-codex | unprovisioned |');
    expect(md).toContain('| acp-image-read | optional |');
  });
});
