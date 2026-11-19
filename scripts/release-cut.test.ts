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
// (`mover`) that lands merges on dev. The version decisions and the gate commands are stubs on
// PATH, and the gates command is the real scripts/release-gates.sh: `all` runs its own dispatch, so
// a case label executed as a command fails the cut instead of passing silently.
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
  const gateLog = join(dir, 'gate.log');
  writeFileSync(bunLog, '');
  writeFileSync(gatesLog, '');
  writeFileSync(gateLog, '');
  // Every stub logs `<folder> :: <argv>` to the gate log; the version/lane decisions are kept out of
  // it, so the gate commands are asserted in the exact order release-gates.sh ran them.
  const logCall = `printf '%s :: %s\\n' "\${PWD##*/}" "$*" >> "\${GATE_LOG:-/dev/null}"`;
  const failIfAsked = `if [[ "\${FAIL_GATE:-}" == "$*" ]]; then echo "stub: $* failed" >&2; exit 1; fi`;
  writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "\${BUN_LOG:-/dev/null}"
case "$*" in
  "scripts/lane.ts next-patch") echo 3.0.1; exit 0 ;;
  "scripts/version.ts next") echo 3.0.1; exit 0 ;;
  "scripts/version.ts set "*) printf '{"version":"%s"}\\n' "$3" > package.json; exit 0 ;;
  "scripts/version.ts check") exit 0 ;;
  "scripts/lane.ts kind "*) echo "\${FAKE_KIND:-plugins}"; exit 0 ;;
  "scripts/lane.ts herdr "*) echo "\${FAKE_HERDR:-no}"; exit 0 ;;
  "scripts/lane.ts pocket-since "*) echo 3.0.0; exit 0 ;;
  "scripts/lane.ts pocket "*) echo "\${FAKE_POCKET:-no}"; exit 0 ;;
  "scripts/lane.ts meter-since "*) echo 3.0.0; exit 0 ;;
  "scripts/lane.ts meter "*) echo "\${FAKE_METER:-no}"; exit 0 ;;
  "scripts/lane.ts ships "*) echo "\${FAKE_SHIPS:-yes}"; exit 0 ;;
esac
${logCall}
${failIfAsked}
case "$*" in
  "install --frozen-lockfile --ignore-scripts" | "run check" | "scripts/am-lane.ts check-key" | "scripts/herdr-lane.ts check-key" | "scripts/meter-lane.ts check-key" | "scripts/lane.ts pack-addons release") exit 0 ;;
  *) echo "unexpected bun: $*" >&2; exit 2 ;;
esac
`);
  writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
${logCall}
${failIfAsked}
exit 0
`);
  writeFileSync(join(bin, 'shellcheck'), `#!/usr/bin/env bash
set -euo pipefail
${logCall}
${failIfAsked}
exit 0
`);
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *"release download"*) exit 1 ;;
  *) exit 0 ;;
esac
`);
  writeFileSync(join(bin, 'jq'), '#!/usr/bin/env bash\ncat >/dev/null\nexit 0\n');
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'shellcheck'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'jq'), 0o755);
  // The scripts find the repository from their own path, so they run from this work tree. The gate
  // commands need the folders the workflow's gates run in, and the herdr-app check's install.sh.
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(root, 'scripts', 'release-cut.sh'), join(work, 'scripts', 'release-cut.sh'));
  copyFileSync(join(root, 'scripts', 'release-gates.sh'), join(work, 'scripts', 'release-gates.sh'));
  for (const app of ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'welcome-dsh']) mkdirSync(join(work, 'apps', app), { recursive: true });
  mkdirSync(join(work, 'am'));
  mkdirSync(join(work, 'herdr'));
  writeFileSync(join(work, 'herdr', 'install.sh'), '');
  // A logging delegator, not a fake: every call, `all` included, is the real release-gates.sh.
  writeFileSync(join(bin, 'gates'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "\${GATES_LOG:-/dev/null}"
exec bash ${JSON.stringify(join(work, 'scripts', 'release-gates.sh'))} "$@"
`);
  chmodSync(join(bin, 'gates'), 0o755);

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
        GATE_LOG: gateLog,
        GITHUB_REPOSITORY: 'owner/repo',
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
    return { status: done.status, out: done.stdout, err: done.stderr, output: readFileSync(output, 'utf8'), bun: lines(bunLog), gates: lines(gatesLog), gateCalls: lines(gateLog) };
  };
  // The real gates script, with the stub toolchain on PATH: the dispatch, its order and its
  // failures are the script's own.
  const runGates = (args: string[], env: Record<string, string> = {}) => {
    const output = join(dir, 'gates-output');
    writeFileSync(output, '');
    return spawnSync('bash', [join(work, 'scripts', 'release-gates.sh'), ...args], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        BUN_LOG: bunLog,
        GATE_LOG: gateLog,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_OUTPUT: output,
        ...env,
      },
    });
  };
  return { dir, work, bin, bare, mover, run, runGates, move, remote, gateLog, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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
      // `all` really ran: every gate's command, in the workflow's order, went through the stubs.
      expect(run.gateCalls).toEqual([
        'work :: install --frozen-lockfile --ignore-scripts',
        'work :: run check',
        'acp-dsh :: install --frozen-lockfile --ignore-scripts',
        'bots-dsh :: install --frozen-lockfile --ignore-scripts',
        'locale-pt-br-dsh :: install --frozen-lockfile --ignore-scripts',
        'welcome-dsh :: install --frozen-lockfile --ignore-scripts',
        'am :: ../scripts/am-copies.mjs --check',
        'am :: --test test/*.test.mjs',
        'am :: --check *.js',
        'am :: --check *.mjs',
        'am :: --check bin/*.mjs',
        'am :: --check lib/*.mjs',
        'am :: -s sh bin/am bin/run.sh bin/automagik-herdr',
        'work :: scripts/am-lane.ts check-key',
        'work :: scripts/lane.ts pack-addons release',
      ]);
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

describe('the gates script runs the gates for real', () => {
  const callsOf = (repo: ReturnType<typeof repository>) => readFileSync(repo.gateLog, 'utf8').trim().split('\n').filter(Boolean);

  test('all runs every gate its lane needs, in the workflow order', () => {
    const repo = repository();
    try {
      const done = repo.runGates(['all', 'plugins', 'no', 'no', 'no']);
      expect(done.status).toBe(0);
      expect(done.stderr).toBe('');
      // A case label called as a command would exit 127 here before the first gate, as it did
      // before #1653: the plugins lane's whole set is base, then am, then the add-ons.
      expect(callsOf(repo)).toEqual([
        'work :: install --frozen-lockfile --ignore-scripts',
        'work :: run check',
        'acp-dsh :: install --frozen-lockfile --ignore-scripts',
        'bots-dsh :: install --frozen-lockfile --ignore-scripts',
        'locale-pt-br-dsh :: install --frozen-lockfile --ignore-scripts',
        'welcome-dsh :: install --frozen-lockfile --ignore-scripts',
        'am :: ../scripts/am-copies.mjs --check',
        'am :: --test test/*.test.mjs',
        'am :: --check *.js',
        'am :: --check *.mjs',
        'am :: --check bin/*.mjs',
        'am :: --check lib/*.mjs',
        'am :: -s sh bin/am bin/run.sh bin/automagik-herdr',
        'work :: scripts/am-lane.ts check-key',
        'work :: scripts/lane.ts pack-addons release',
      ]);
    } finally {
      repo.cleanup();
    }
  });

  test('one gate runs only its own commands', () => {
    const repo = repository();
    try {
      const done = repo.runGates(['am']);
      expect(done.status).toBe(0);
      expect(callsOf(repo)).toEqual([
        'am :: ../scripts/am-copies.mjs --check',
        'am :: --test test/*.test.mjs',
        'am :: --check *.js',
        'am :: --check *.mjs',
        'am :: --check bin/*.mjs',
        'am :: --check lib/*.mjs',
        'am :: -s sh bin/am bin/run.sh bin/automagik-herdr',
      ]);
    } finally {
      repo.cleanup();
    }
  });

  test('a failing gate exits non-zero with its own message and runs nothing after it', () => {
    const repo = repository();
    try {
      const done = repo.runGates(['all', 'plugins', 'no', 'no', 'no'], { FAIL_GATE: 'run check' });
      expect(done.status).not.toBe(0);
      expect(done.stderr).toContain('stub: run check failed');
      expect(callsOf(repo)).toEqual([
        'work :: install --frozen-lockfile --ignore-scripts',
        'work :: run check',
      ]);
    } finally {
      repo.cleanup();
    }
  });

  test('a herdr lane runs the herdr gates and its key check, and no add-ons', () => {
    const repo = repository();
    try {
      const done = repo.runGates(['all', 'herdr', 'yes', 'no', 'no']);
      expect(done.status).toBe(0);
      const calls = callsOf(repo);
      const at = (needle: string) => calls.findIndex(line => line.includes(needle));
      expect(at("herdr :: --test test/*.test.mjs")).toBeGreaterThan(0);
      expect(at('herdr :: --test test/mod-imports.test.mjs')).toBeGreaterThan(at("herdr :: --test test/*.test.mjs"));
      expect(at('work :: .github/scripts/herdr-app-check.mjs --strict')).toBeGreaterThan(at('herdr :: --test test/mod-imports.test.mjs'));
      expect(at('work :: scripts/herdr-lane.ts check-key')).toBeGreaterThan(at('work :: .github/scripts/herdr-app-check.mjs --strict'));
      expect(at('am :: ../scripts/am-copies.mjs --check')).toBeGreaterThan(at('work :: scripts/herdr-lane.ts check-key'));
      expect(at('work :: scripts/am-lane.ts check-key')).toBeGreaterThan(at('am :: ../scripts/am-copies.mjs --check'));
      expect(calls.some(line => line.includes('pack-addons'))).toBe(false);
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
      ["The herdr pack's signing key", 'herdr-key'],
      ["The am part's gates", 'am'],
      ["The am lane's signing key", 'am-key'],
      ["The meter's gates", 'meter'],
      ["The meter lane's signing key", 'meter-key'],
      ["Pocket's gates", 'pocket'],
      ["Pocket's signing key is in the secrets", 'pocket-key'],
      ['Pack the add-ons the lane carries', 'addons release'],
    ];
    for (const [name, args] of calls) expect(step(name)).toContain(`run: bash scripts/release-gates.sh ${args}`);
  });

  test('the cut step calls release-cut.sh with the lane it gated and the keys a re-cut re-checks', () => {
    const cut = step('Version, commit and tag');
    expect(cut).toContain('run: bash scripts/release-cut.sh');
    for (const name of ['KIND', 'HERDR', 'POCKET', 'METER']) expect(cut).toContain(`${name}: \${{ steps.lane.outputs.`);
    // The signing-key checks read the tree, so the retry needs the same secrets their steps got.
    for (const name of ['HERDR_PACK_KEY', 'AM_LANE_KEY', 'METER_LANE_KEY', 'HAS_KEYSTORE', 'HAS_PASSWORD']) expect(cut).toContain(`${name}:`);
  });

  test('the herdr key check, the cut and the signing step select the same slot, with no fallback to the primary', () => {
    const selected = "HERDR_PACK_KEY: ${{ vars.HERDR_PACK_SIGNER == 'HERDR_PACK_KEY_NEXT' && secrets.HERDR_PACK_KEY_NEXT || vars.HERDR_PACK_SIGNER != 'HERDR_PACK_KEY_NEXT' && secrets.HERDR_PACK_KEY || '' }}";
    for (const name of ["The herdr pack's signing key", 'Version, commit and tag', 'Sign and post the herdr lane']) {
      const lines = step(name).split('\n').map(line => line.trim());
      expect(lines.filter(line => line.startsWith('HERDR_PACK_KEY:'))).toEqual([selected]);
      expect(lines).toContain('HERDR_PACK_SIGNER: ${{ vars.HERDR_PACK_SIGNER }}');
      expect(step(name)).not.toContain('|| secrets.HERDR_PACK_KEY }}');
    }
  });

  test('the scripts still carry the gates they replaced', () => {
    for (const command of [
      "node --test 'test/*.test.mjs'",
      'node .github/scripts/herdr-app-check.mjs --strict',
      'node ../scripts/am-copies.mjs --check',
      'cargo clippy --all-targets --locked -- -D warnings',
      './gradlew --stacktrace :app:testDebugUnitTest :app:lintDebug',
      'bun scripts/herdr-lane.ts check-key',
      'bun scripts/am-lane.ts check-key',
      'bun scripts/meter-lane.ts check-key',
      'POCKET_SIGNING_KEYSTORE',
      'bun scripts/lane.ts pack-addons',
      'bun run check',
    ]) expect(gatesScript).toContain(command);
    // The lane decision moved into the script, every key it writes intact.
    for (const key of ['kind', 'herdr', 'pocket', 'pocket_since', 'meter', 'ships', 'base']) expect(gatesScript).toContain(`echo "${key}=`);
    // `all` calls gate functions, never a case label as a command (the #1653 defect).
    const allBody = gatesScript.slice(gatesScript.indexOf('\nall() {'), gatesScript.indexOf('\ncase "${1:-}"'));
    for (const gate of ['gate_base', 'gate_herdr', 'gate_herdr_imports', 'gate_herdr_app', 'gate_herdr_key', 'gate_am', 'gate_am_key', 'gate_meter', 'gate_meter_key', 'gate_pocket', 'gate_pocket_key', 'gate_addons']) {
      expect(allBody).toMatch(new RegExp(`\\b${gate}\\b`));
    }
    // The cut keeps the bounded retry and the atomic push.
    expect(cutScript).toContain('RELEASE_CUT_ATTEMPTS');
    expect(cutScript).toContain('git push -q --atomic origin HEAD:refs/heads/dev "refs/tags/v${version}"');
  });
});
