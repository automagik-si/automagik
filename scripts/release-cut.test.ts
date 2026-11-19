// The cut that loses its push (#668): when a merge lands on dev while the gates run, the cut
// re-decides the lane and re-runs the gates on the new tip, then retries the atomic push a bounded
// number of times. A lane that changes under it, a non-race push failure, and a dev that never
// stops moving each keep their old, safe outcome.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const cutScript = readFileSync(join(root, 'scripts', 'release-cut.sh'), 'utf8');
const gatesScript = readFileSync(join(root, 'scripts', 'release-gates.sh'), 'utf8');
const workflow = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');

// A repository whose dev is tagged v3.0.0, a bare origin it pushes to, and a second clone
// (`mover`) that lands merges on dev. The cut runs with fake `bun` and gates on PATH: the version
// decisions and the lane/gate calls are logged, never run.
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'release-cut-'));
  const git = (cwd: string, ...args: string[]) => {
    const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
    return run.stdout.trim();
  };
  const bare = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const mover = join(dir, 'mover');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  git(dir, 'init', '-q', '--bare', bare);
  git(dir, 'clone', '-q', bare, work);
  git(work, 'checkout', '-q', '-b', 'dev');
  writeFileSync(join(work, 'package.json'), '{"version":"3.0.0"}\n');
  writeFileSync(join(work, 'README.md'), '# base\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'chore: the base');
  git(work, 'tag', 'v3.0.0');
  git(work, 'push', '-q', '-u', 'origin', 'dev');
  git(work, 'push', '-q', 'origin', 'v3.0.0');
  git(dir, 'clone', '-q', bare, mover);
  git(mover, 'checkout', '-q', 'dev');

  const bunLog = join(dir, 'bun.log');
  const gatesLog = join(dir, 'gates.log');
  writeFileSync(bunLog, '');
  writeFileSync(gatesLog, '');
  writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$BUN_LOG"
case "$*" in
  "scripts/lane.ts next-patch") echo 3.0.1 ;;
  "scripts/version.ts next") echo 3.0.1 ;;
  "scripts/version.ts set "*) printf '{"version":"%s"}\\n' "$3" > package.json ;;
  "scripts/version.ts check") : ;;
  *) echo "unexpected bun: $*" >&2; exit 2 ;;
esac
`);
  writeFileSync(join(bin, 'gates'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$GATES_LOG"
case "$1" in
  lane)
    {
      echo "kind=\${FAKE_KIND:-plugins}"
      echo "herdr=\${FAKE_HERDR:-no}"
      echo "pocket=\${FAKE_POCKET:-no}"
      echo "pocket_since=3.0.0"
      echo "meter=\${FAKE_METER:-no}"
      echo "ships=\${FAKE_SHIPS:-yes}"
      echo "base=3.0.0"
    } > "$2"
    ;;
  all) : ;;
  *) echo "unexpected gates: $*" >&2; exit 2 ;;
esac
`);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'gates'), 0o755);
  // The script finds the repository from its own path, so it runs from this work tree.
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(root, 'scripts', 'release-cut.sh'), join(work, 'scripts', 'release-cut.sh'));

  const move = (subject = 'fix: a merge during the cut') => {
    writeFileSync(join(mover, `${subject.replace(/\W+/g, '-')}.txt`), `${subject}\n`);
    git(mover, 'add', '-A');
    git(mover, 'commit', '-q', '-m', subject);
    git(mover, 'push', '-q', 'origin', 'dev');
  };
  const remote = (...args: string[]) => git(bare, ...args);
  const run = (env: Record<string, string> = {}) => {
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    const done = spawnSync('bash', [join(work, 'scripts', 'release-cut.sh')], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        BUN_LOG: bunLog,
        GATES_LOG: gatesLog,
        RELEASE_GATES: join(bin, 'gates'),
        KIND: 'plugins',
        HERDR: 'no',
        POCKET: 'no',
        METER: 'no',
        GITHUB_OUTPUT: output,
        ...env,
      },
    });
    const lines = (path: string) => { try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
    return { status: done.status, out: done.stdout, err: done.stderr, output: readFileSync(output, 'utf8'), bun: lines(bunLog), gates: lines(gatesLog) };
  };
  return { dir, work, bare, mover, run, move, remote, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('a cut that dev has not moved past', () => {
  test('pushes the version commit and its tag once, and re-runs no gate', () => {
    const repo = repository();
    try {
      const run = repo.run();
      expect(run.status).toBe(0);
      expect(run.output).toBe('version=3.0.1\nsha=' + repo.remote('rev-parse', 'refs/heads/dev') + '\n');
      expect(run.gates).toEqual([]);
      expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('chore(release): v3.0.1');
      expect(repo.remote('rev-parse', 'refs/tags/v3.0.1^{commit}')).toBe(repo.remote('rev-parse', 'refs/heads/dev'));
    } finally {
      repo.cleanup();
    }
  });
});

describe('a merge that lands while the gates run', () => {
  test('re-cuts on the new tip: re-decides the lane, re-runs the gates, tags the new dev', () => {
    const repo = repository();
    try {
      repo.move();
      const run = repo.run();
      expect(run.status).toBe(0);
      expect(run.out).toContain('re-cutting on the new tip (attempt 2 of 3)');
      expect(run.gates.length).toBe(2);
      expect(run.gates[0].startsWith('lane ')).toBe(true);
      expect(run.gates[1]).toBe('all plugins no no no');
      expect(run.output).toBe('version=3.0.1\nsha=' + repo.remote('rev-parse', 'refs/heads/dev') + '\n');
      expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('chore(release): v3.0.1');
      // The merge is the release commit's parent: the tag names the tree the second gates saw.
      expect(repo.remote('log', '-1', '--format=%s', 'dev^')).toBe('fix: a merge during the cut');
      expect(repo.remote('rev-parse', 'refs/tags/v3.0.1^{commit}')).toBe(repo.remote('rev-parse', 'refs/heads/dev'));
    } finally {
      repo.cleanup();
    }
  });

  test('a new dev that reaches no install is left to the queued run: no gate re-run, no tag', () => {
    const repo = repository();
    try {
      repo.move();
      const run = repo.run({ FAKE_SHIPS: 'no' });
      expect(run.status).toBe(0);
      expect(run.out).toContain('nothing that reaches an install');
      expect(run.gates.length).toBe(1);
      expect(run.gates[0].startsWith('lane ')).toBe(true);
      expect(repo.remote('tag', '--list')).toBe('v3.0.0');
    } finally {
      repo.cleanup();
    }
  });

  test('a lane the merge changed is left to the queued run: no gate re-run, no tag', () => {
    const repo = repository();
    try {
      repo.move();
      const run = repo.run({ FAKE_KIND: 'herdr' });
      expect(run.status).toBe(0);
      expect(run.out).toContain('changed the lane');
      expect(run.gates.length).toBe(1);
      expect(run.gates[0].startsWith('lane ')).toBe(true);
      expect(repo.remote('tag', '--list')).toBe('v3.0.0');
    } finally {
      repo.cleanup();
    }
  });

  test('a dev that keeps moving stops cleanly after the bounded attempts, with no tag', () => {
    const repo = repository();
    try {
      // A pre-receive hook that rejects each push and moves dev, as a merge winning the race does.
      const hook = join(repo.bare, 'hooks', 'pre-receive');
      mkdirSync(join(repo.bare, 'hooks'), { recursive: true });
      writeFileSync(hook, `#!/usr/bin/env bash
set -euo pipefail
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
# Receive-pack quarantines the pushed objects; build and write the merge in the main store.
clean() { env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES "$@"; }
tree=$(git rev-parse 'refs/heads/dev^{tree}')
new=$(clean git commit-tree "$tree" -p refs/heads/dev -m 'fix: another merge wins the race')
clean git update-ref refs/heads/dev "$new"
exit 1
`);
      chmodSync(hook, 0o755);
      const run = repo.run({ RELEASE_CUT_ATTEMPTS: '2' });
      expect(run.status).toBe(0);
      expect(run.out).toContain('on each of 2 attempts');
      expect(run.gates.filter(call => call.startsWith('all ')).length).toBe(1);
      expect(repo.remote('tag', '--list')).toBe('v3.0.0');
    } finally {
      repo.cleanup();
    }
  });

  test('a push that fails while dev stands still fails the run after one attempt', () => {
    const repo = repository();
    try {
      const hook = join(repo.bare, 'hooks', 'pre-receive');
      mkdirSync(join(repo.bare, 'hooks'), { recursive: true });
      writeFileSync(hook, '#!/usr/bin/env bash\nexit 1\n');
      chmodSync(hook, 0o755);
      const run = repo.run();
      expect(run.status).toBe(1);
      expect(run.gates).toEqual([]);
      expect(run.out).not.toContain('re-cutting');
      expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('chore: the base');
    } finally {
      repo.cleanup();
    }
  });
});

describe('the workflow runs the gates and the cut from their scripts', () => {
  const step = (name: string) => {
    const at = workflow.indexOf(`- name: ${name}`);
    expect(at).toBeGreaterThan(-1);
    const next = workflow.indexOf('\n      - ', at + 1);
    return workflow.slice(at, next < 0 ? undefined : next);
  };

  test('every pre-cut gate step calls release-gates.sh with its part', () => {
    const calls: [string, string][] = [
      ['The gates the release stands on', 'base'],
      ['Which lane', 'lane'],
      ["The herdr pack's gates", 'herdr'],
      ["Every pack mod's import graph", 'herdr-imports'],
      ['Every pack mod loads in herdr-app', 'herdr-app'],
      ["The am part's gates", 'am'],
      ["The meter's gates", 'meter'],
      ["Pocket's gates", 'pocket'],
      ['Pack the add-ons the lane carries', 'addons release'],
    ];
    for (const [name, args] of calls) expect(step(name)).toContain(`run: bash scripts/release-gates.sh ${args}`);
  });

  test('the cut step calls release-cut.sh with the lane it gated', () => {
    const cut = step('Version, commit and tag');
    expect(cut).toContain('run: bash scripts/release-cut.sh');
    for (const name of ['KIND', 'HERDR', 'POCKET', 'METER']) expect(cut).toContain(`${name}: \${{ steps.lane.outputs.`);
  });

  test('the scripts still carry the gates they replaced', () => {
    for (const command of [
      "node --test 'test/*.test.mjs'",
      'node .github/scripts/herdr-app-check.mjs --strict',
      'node ../scripts/am-copies.mjs --check',
      'cargo clippy --all-targets --locked -- -D warnings',
      './gradlew --stacktrace :app:testDebugUnitTest :app:lintDebug',
      'bun scripts/lane.ts pack-addons',
      'bun run check',
    ]) expect(gatesScript).toContain(command);
    // The lane decision moved into the script, every key it writes intact.
    for (const key of ['kind', 'herdr', 'pocket', 'pocket_since', 'meter', 'ships', 'base']) expect(gatesScript).toContain(`echo "${key}=`);
    // The cut keeps the bounded retry and the atomic push.
    expect(cutScript).toContain('RELEASE_CUT_ATTEMPTS');
    expect(cutScript).toContain('git push -q --atomic origin HEAD:refs/heads/dev "refs/tags/v${version}"');
  });
});
