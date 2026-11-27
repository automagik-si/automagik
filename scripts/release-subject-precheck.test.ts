// The cut's "Anything new since the last release" step, run as release-verify.yml writes it: the path
// decision (`scripts/lane.ts ships <last>`) is authoritative, and the commit subjects only choose
// the skip wording (#767). Every case below is a throwaway repository whose commits carry real
// changed paths, with a fake `bun` answering `ships` from `git diff --name-only`.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The step's shell, exactly as the workflow writes it. The step is the unit under test: it is
// extracted here rather than copied, so a change to release-verify.yml is what the tests run.
function releaseStep(): string {
  const lines = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release-verify.yml'), 'utf8').split('\n');
  const start = lines.findIndex(line => line.trim() === '- name: Anything new since the last release');
  if (start < 0) throw new Error('release-verify.yml has no "Anything new since the last release" step');
  const run = lines.findIndex((line, index) => index > start && /^\s*run: \|$/.test(line));
  if (run < 0) throw new Error('the step has no run: block');
  const body: string[] = [];
  let bodyIndent: number | null = null;
  for (let index = run + 1; index < lines.length; index++) {
    const line = lines[index];
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (line.trim() !== '' && bodyIndent === null) bodyIndent = indent;
    if (line.trim() !== '' && bodyIndent !== null && indent < bodyIndent) break;
    body.push(bodyIndent === null ? '' : line.slice(bodyIndent));
  }
  return body.join('\n').trimEnd();
}

const script = releaseStep();

// The fake `scripts/lane.ts ships <last>`: a changed path under a shipped root means yes, anything
// else means no, and the release's own version-only package.json bump is not modelled. Every call
// is logged so a test can prove the step asked exactly once, about the newest v3 tag.
const SHIPS = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'if [[ "$#" -ne 3 || "$1" != "scripts/lane.ts" || "$2" != "ships" ]]; then',
  "  printf 'unexpected command: %s\\n' \"$*\" >&2",
  '  exit 64',
  'fi',
  'printf "%s\\n" "$*" >> .ships-calls',
  'last="$3"',
  'ships=no',
  'while IFS= read -r path; do',
  '  case "$path" in',
  '    apps/*|herdr/*|am/*|meter/*|package.json) ships=yes ;;',
  '  esac',
  'done <<< "$(git diff --name-only "$last"..HEAD)"',
  'printf "%s\\n" "$ships"',
].join('\n');

const FAILING = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'printf "%s\\n" "$*" >> .ships-calls',
  'exit 7',
].join('\n');

const MAYBE = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'printf "%s\\n" "$*" >> .ships-calls',
  'printf "maybe\\n"',
].join('\n');

type Commit = { subject: string; files?: Record<string, string> };
type Run = { status: number | null; stdout: string; stderr: string; output: string; calls: string[] };

// A repository seeded at v3.0.0, bumped and tagged v3.2.0, then the commits under test. The temp
// GITHUB_OUTPUT and the fake bun live outside the repository, so they never enter a diff.
function runStep(commits: Commit[], options: { tags?: boolean; bun?: string } = {}): Run {
  const root = mkdtempSync(join(tmpdir(), 'release-subject-precheck-'));
  const repo = join(root, 'repo');
  const bin = join(root, 'bin');
  const output = join(root, 'github-output');
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(output, '');
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GITHUB_OUTPUT: output,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (...args: string[]) => {
    const done = spawnSync('git', [
      '-c', 'user.name=t',
      '-c', 'user.email=t@example.invalid',
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      ...args,
    ], { cwd: repo, encoding: 'utf8', env });
    if (done.status !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr}`);
    return done.stdout;
  };
  try {
    git('init', '-q', '-b', 'dev');
    writeFileSync(join(repo, 'package.json'), '{"version":"3.0.0"}\n');
    writeFileSync(join(repo, 'README.md'), '# base\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'chore(release): 3.0.0');
    if (options.tags !== false) {
      git('tag', 'v3.0.0');
      writeFileSync(join(repo, 'package.json'), '{"version":"3.2.0"}\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'chore(release): 3.2.0');
      git('tag', 'v3.2.0');
    }
    for (const { subject, files = {} } of commits) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, path)), { recursive: true });
        writeFileSync(join(repo, path), text);
      }
      git('add', '-A');
      git('commit', '-q', '-m', subject);
    }
    writeFileSync(join(bin, 'bun'), options.bun ?? SHIPS);
    chmodSync(join(bin, 'bun'), 0o755);
    const done = spawnSync('bash', ['-c', script], { cwd: repo, encoding: 'utf8', env });
    let calls: string[] = [];
    try {
      calls = readFileSync(join(repo, '.ships-calls'), 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      // never asked
    }
    return { status: done.status, stdout: done.stdout ?? '', stderr: done.stderr ?? '', output: readFileSync(output, 'utf8'), calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// One shipped source change under each inert subject kind: the diff says yes, so the subject must
// not skip the release.
const INERT_SHIPPING = [
  {
    kind: 'test(...)',
    subject: 'test(pocket): unit-test the view-model chat wiring (#754)',
    path: 'apps/pocket/android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt',
  },
  {
    kind: 'docs(...)',
    subject: 'docs(herdr): describe the sidebar contract',
    path: 'herdr/mods/am-sidebar/main.js',
  },
  {
    kind: 'ci(...)',
    subject: 'ci(am): run the briefing test on Linux',
    path: 'am/lib/briefing.mjs',
  },
  {
    kind: 'chore(release)',
    subject: 'chore(release): carry the meter source',
    path: 'meter/usagemeter/src/lib.rs',
  },
];

// A subject and a path the fake lane never ships: the real repository's docs, scripts and CI
// files, plus a changelog a release commit may touch.
const INERT_ONLY = [
  {
    kind: 'test(...)',
    subject: 'test(pocket): cover the view-model chat wiring',
    path: 'scripts/pocket-view-model.test.ts',
  },
  {
    kind: 'docs(...)',
    subject: 'docs(guide): explain the cut',
    path: 'docs/cut.md',
  },
  {
    kind: 'ci(...)',
    subject: 'ci(workflows): run the cut on Linux',
    path: '.github/workflows/ci.yml',
  },
  {
    kind: 'chore(release)',
    subject: 'chore(release): 3.2.1',
    path: 'CHANGELOG.md',
  },
];

describe("the cut's subject precheck", () => {
  for (const shape of INERT_SHIPPING) {
    test(`a shipped source change under ${shape.kind} releases`, () => {
      const run = runStep([{ subject: shape.subject, files: { [shape.path]: '// shipped\n' } }]);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
      expect(run.output).toBe('release=true\n');
      expect(run.stdout).toBe('');
    });
  }

  test('a range of nothing but inert subjects still releases when the diff ships', () => {
    const run = runStep(INERT_SHIPPING.map(shape => ({ subject: shape.subject, files: { [shape.path]: '// shipped\n' } })));
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('release=true\n');
    expect(run.stdout).toBe('');
  });

  test('one inert commit after v3.2.0 asks about v3.2.0 and skips with the dev wording', () => {
    const run = runStep([{ subject: 'docs(guide): explain the cut', files: { 'docs/cut.md': '# cut\n' } }]);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('');
    expect(run.stdout).toBe('dev has nothing since v3.2.0: no release\n');
  });

  test('every inert kind in a ships=no range keeps the dev wording', () => {
    const run = runStep(INERT_ONLY.map(shape => ({ subject: shape.subject, files: { [shape.path]: '# inert\n' } })));
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('');
    expect(run.stdout).toBe('dev has nothing since v3.2.0: no release\n');
  });

  for (const subject of ['docs(guide): explain the cut', 'test: cover the cut']) {
    test(`${subject} is inert when the diff ships nothing`, () => {
      const run = runStep([{ subject, files: { 'scripts/cut.test.ts': '// test\n' } }]);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
      expect(run.output).toBe('');
      expect(run.stdout).toBe('dev has nothing since v3.2.0: no release\n');
    });
  }

  test('a non-inert subject among inert ones gets the reaches-an-install wording', () => {
    const run = runStep([
      { subject: 'docs(guide): explain the cut', files: { 'docs/cut.md': '# cut\n' } },
      { subject: 'feat(bots): teach the host a new route', files: { 'scripts/routes.ts': 'export {};\n' } },
      { subject: 'test(bots): cover the route', files: { 'scripts/routes.test.ts': '// test\n' } },
    ]);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('');
    expect(run.stdout).toBe('nothing since v3.2.0 reaches an install: no release\n');
  });

  test('chore(deps) is not inert even when it ships nothing', () => {
    const run = runStep([{ subject: 'chore(deps): bump the release helper', files: { 'scripts/package.json': '{"version":"9.9.9"}\n' } }]);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('');
    expect(run.stdout).toBe('nothing since v3.2.0 reaches an install: no release\n');
  });

  test('the first release, with no tag at all, releases without asking ships', () => {
    const run = runStep([{ subject: 'feat(bots): the first cut', files: { 'apps/bots-dsh/src/host/agents.js': 'export {};\n' } }], { tags: false });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.output).toBe('release=true\n');
    expect(run.stdout).toBe('');
  });

  test('a failing ships call stops the run with no release output', () => {
    const run = runStep([{ subject: 'docs(guide): explain the cut', files: { 'docs/cut.md': '# cut\n' } }], { bun: FAILING });
    expect(run.status).not.toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('');
    expect(run.stdout).not.toContain('release=true');
    expect(run.stdout).not.toContain('no release');
  });

  test('a ships answer other than yes or no stops the run with no release output', () => {
    const run = runStep([{ subject: 'feat(bots): teach the host a new route', files: { 'apps/bots-dsh/src/host/agents.js': 'export {};\n' } }], { bun: MAYBE });
    expect(run.status).not.toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.2.0']);
    expect(run.output).toBe('');
    expect(run.stdout).not.toContain('release=true');
    expect(run.stdout).not.toContain('no release');
  });
});
