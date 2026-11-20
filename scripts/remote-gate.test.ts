// #714: the plugin lane runs lint only when package.json has a lint script. gate_plugin and its
// step/judge helpers are extracted from remote-gate.sh and run as written against fixture apps: a
// no-lint app with green tests gates green, a lint script is still invoked, and a failing lint
// still fails the gate. The fixture's bun is a stand-in; the full remote run is not exercised.
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'remote-gate.sh'), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'remote-gate-lint-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// One function body, from its name to its closing brace in the first column.
function fn(name: string): string {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`remote-gate.sh has no ${name}()`);
  return source.slice(start, end + 3);
}

const BUN = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
case "$1 $2" in
  'install --frozen-lockfile') exit 0 ;;
  'run lint') exit "$LINT_EXIT" ;;
  'run test')
    printf '%s\\n' 'TAP version 13' '1..2' 'ok 1 - one' 'ok 2 - two' \\
      '# tests 2' '# pass 2' '# fail 0' '# skipped 0' '# todo 0' '# cancelled 0'
    exit 0
    ;;
esac
exit 0
`;

let runs = 0;
function gate(packageJson: Record<string, unknown>, lintExit = 0, app = 'fixture') {
  const dir = join(work, `gate-${runs++}`);
  const plugin = join(dir, 'apps', app);
  const bin = join(dir, 'bin');
  const calls = join(dir, 'calls');
  mkdirSync(join(plugin, 'test'), { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(plugin, 'package.json'), JSON.stringify(packageJson));
  writeFileSync(join(plugin, 'test', 'fixture.test.js'), '');
  writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\necho v22.0.0\n');
  writeFileSync(join(bin, 'bun'), BUN);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'bun'), 0o755);

  const harness = join(dir, 'harness.sh');
  writeFileSync(harness, `set -euo pipefail
say() { printf 'remote-gate: %s\\n' "$*"; }
die() { say "$*" >&2; exit 1; }
node_bin() { printf '%s\\n' "$FAKE_BIN"; }
browser() { :; }
${fn('step')}
${fn('node_counts')}
${fn('judge')}
${fn('gate_plugin')}
wt=$PWD
app=${app}
plugin_node=24.9
logs=$PWD/logs
failed=0
summary=()
gate_plugin
printf 'gate failed=%s\\n' "$failed"
exit "$failed"
`);
  const result = spawnSync('bash', [harness], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', FAKE_BIN: bin, CALLS: calls, LINT_EXIT: String(lintExit) },
  });
  let called: string[] = [];
  try {
    called = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    // No bun call at all leaves no log; the assertions below report that.
  }
  return { ...result, calls: called };
}

describe('the plugin gate lint step (#714)', () => {
  test('an app without a lint script says skipped and gates green on green tests', () => {
    const result = gate({ name: 'fixture', scripts: { test: 'node --test' } });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('remote-gate: lint skipped (no lint script)');
    expect(result.stdout).toContain('tests=2 pass=2 fail=0');
    expect(result.stdout).toContain('gate failed=0');
    expect(result.calls).not.toContain('run lint');
    expect(result.calls).toContain('run test');
  });

  test('an app with a lint script still runs it', () => {
    const fixture = { name: 'fixture', scripts: { lint: 'node lint.js', test: 'node --test' } };
    const result = gate(fixture);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('step lint: exit 0');
    expect(result.stdout).not.toContain('lint skipped');
    expect(result.calls).toContain('run lint');
    expect(result.calls).toContain('run test');
  });

  test('a failing lint still fails the gate while the tests are green', () => {
    const fixture = { name: 'fixture', scripts: { lint: 'node lint.js', test: 'node --test' } };
    const result = gate(fixture, 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('step lint: exit 1');
    expect(result.stdout).toContain('tests=2 pass=2 fail=0');
    expect(result.stdout).toContain('gate failed=1');
  });
});

test('only the bots-dsh gate installs the ACP dependencies for its role identity test', () => {
  const install = 'install --cwd ../acp-dsh --frozen-lockfile';
  const bots = gate({ name: 'bots-dsh' }, 0, 'bots-dsh');
  const fixture = gate({ name: 'fixture' });
  expect(bots.status).toBe(0);
  expect(fixture.status).toBe(0);
  expect(bots.calls).toContain(install);
  expect(fixture.calls).not.toContain(install);
});

// #586: the held Lows from the #577 reviews. The lock, stamp and count helpers are extracted from
// remote-gate.sh and run as written, in a temp folder: no clone, no gate and no real lock.
function helpers(body: string, env: Record<string, string> = {}) {
  const dir = join(work, `helpers-${runs++}`);
  mkdirSync(join(dir, 'locks'), { recursive: true });
  const harness = join(dir, 'harness.sh');
  writeFileSync(harness, `set -euo pipefail
say() { printf 'remote-gate: %s\\n' "$*"; }
base=$PWD
lock_dir=$PWD/locks
git_lock=$lock_dir/git
git_timeout=2
held_git=''
boot_id=this-boot
${fn('ident')}
${fn('alive')}
${fn('other_boot')}
${fn('git_lock_clear')}
${fn('git_lock_take')}
${fn('git_lock_drop')}
${fn('stamp_file')}
${fn('stamp')}
${fn('node_counts')}
me=$(ident $$)
${body}
`);
  const result = spawnSync('bash', [harness], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { ...result, dir };
}

describe('the clone\'s git lock after a reboot (#586)', () => {
  // A pid that is surely gone: far above any pid_max.
  const lock = (boot: string) => `mkdir "$git_lock"; echo "99999999 ticks:1 boot:${boot}" > "$git_lock/owner"`;

  test('a lock whose owner names another boot id is cleared and the gate proceeds', () => {
    const result = helpers(`${lock('boot-before-the-reboot')}
git_lock_take
printf 'owner=%s me=%s\\n' "$(cat "$git_lock/owner")" "$me"
ls -A "$git_lock"
git_lock_drop
[ ! -e "$git_lock" ] && echo dropped
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('cleared the clone\'s git lock, left from before a reboot (owner: 99999999 ticks:1 boot:boot-before-the-reboot)');
    const [, owner, me] = /owner=(.*) me=(.*)/.exec(result.stdout) ?? [];
    expect(owner).toBe(me);
    expect(owner).toContain('boot:this-boot');
    expect(result.stdout).toContain('\nowner\ndropped\n');
    expect(result.stderr).toBe('');
  });

  test('a dead owner of this boot is still never taken over: it is reported, with how to clear it', () => {
    const result = helpers(`${lock('this-boot')}
git_lock_take || echo "refused rc=$?"
cat "$git_lock/owner"
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('refused rc=1');
    expect(result.stdout).toContain('99999999 ticks:1 boot:this-boot');
    expect(result.stderr).toMatch(/older than 2 s and its gate is gone .*\n.*clear it: rm -rf /);
  });

  test('an unknown boot id, on either side, clears nothing', () => {
    for (const [mine, theirs] of [['unknown', 'boot-before-the-reboot'], ['this-boot', 'unknown']]) {
      const result = helpers(`boot_id=${mine}
${lock(theirs)}
git_lock_take || echo "refused rc=$?"
`);
      expect(result.stdout).toContain('refused rc=1');
      expect(result.stdout).not.toContain('cleared');
    }
  });
});

describe('ref stamps and test counts (#586)', () => {
  test('a ref with a slash in its name gets one stamp file, and no two refs share one', () => {
    const result = helpers(`stamp refs/remote-gate/by/hand
stamp refs/remote-gate/by%2Fhand
stamp refs/remote-gate/pr-12
ls -A ref-stamps
`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').sort()).toEqual(['by%252Fhand', 'by%2Fhand', 'pr-12']);
  });

  test('only a TAP or spec summary line counts: no other first word does', () => {
    const counts = () => helpers('node_counts "$LOG"', { LOG: join(work, 'counts.log') }).stdout.trim();
    const log = (text: string) => writeFileSync(join(work, 'counts.log'), text);
    log('# tests 12\n# pass 11\n# fail 1\n# skipped 0\n# todo 0\n# cancelled 0\n');
    expect(counts()).toBe('1 12 11 1 0 0 0');
    log('ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n');
    expect(counts()).toBe('1 3 3 0 0 0 0');
    log('# tests 2\n# pass 2\n# fail 0\n- tests 99\n> fail 7\n✔ pass 5\n  # fail 9\n');
    expect(counts()).toBe('1 2 2 0 0 0 0');
    log('- tests 99\n* pass 99\n');
    expect(counts()).toBe('0 0 0 0 0 0 0');
  });
});

// #646: the desktop lane after #644. gate_desktop and the cache helpers are extracted and run as
// written; npm is a stand-in that records its arguments.
describe('the desktop lane\'s install and npm cache (#646)', () => {
  const NPM = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
if [ "$1" = test ]; then printf '%s\\n' '# tests 1' '# pass 1' '# fail 0' '# cancelled 0' '# skipped 0' '# todo 0'; fi
`;
  function desktop(body: string, env: Record<string, string> = {}) {
    const dir = join(work, `desktop-${runs++}`);
    const app = join(dir, 'wt', 'apps', 'desktop');
    const bin = join(dir, 'bin');
    mkdirSync(join(app, 'test'), { recursive: true });
    mkdirSync(bin);
    mkdirSync(join(dir, 'logs'));
    mkdirSync(join(dir, 'gate-base', 'locks'), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{}');
    writeFileSync(join(app, 'test', 'fixture.test.js'), '');
    writeFileSync(join(bin, 'node'), '#!/usr/bin/env bash\necho v24.9.0\n');
    writeFileSync(join(bin, 'npm'), NPM);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    const harness = join(dir, 'harness.sh');
    writeFileSync(harness, `set -euo pipefail
say() { printf 'remote-gate: %s\\n' "$*"; }
die() { say "$*" >&2; exit 1; }
node_bin() { printf '%s\\n' "$FAKE_BIN"; }
${fn('absolute')}
mtime() { stat -c %Y "$1"; }
${fn('step')}
${fn('node_counts')}
${fn('judge')}
${fn('sweep_npm_cache')}
${fn('gate_desktop')}
top=$PWD
wt=$PWD/wt
base=$PWD/gate-base
lock_dir=$base/locks
slot=$lock_dir/slot-1
mkdir "$slot"
plugin_node=24.9
keep_days=7
logs=$PWD/logs
failed=0
summary=()
npm_cache=$(absolute "\${REMOTE_GATE_NPM_CACHE:-$base/npm-cache}")
${body}
`);
    const calls = join(dir, 'calls');
    const result = spawnSync('bash', [harness], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', FAKE_BIN: bin, CALLS: calls, ...env },
    });
    let called: string[] = [];
    try {
      called = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
    } catch {
      // No npm call at all leaves no log; the assertions below report that.
    }
    return { ...result, calls: called, dir };
  }

  test('npm ci keeps the devDependencies whatever the box\'s npmrc says, and the gate is green', () => {
    const result = desktop('gate_desktop\nexit "$failed"', { NODE_ENV: 'production', npm_config_omit: 'dev' });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([`ci --no-fund --no-audit --include=dev --cache ${join(result.dir, 'gate-base', 'npm-cache')}`, 'test']);
  });

  test('a relative REMOTE_GATE_NPM_CACHE is taken from where the gate started, not from the worktree', () => {
    const result = desktop('gate_desktop\nexit "$failed"', { REMOTE_GATE_NPM_CACHE: 'my-cache' });
    expect(result.status).toBe(0);
    expect(result.calls[0]).toBe(`ci --no-fund --no-audit --include=dev --cache ${join(result.dir, 'my-cache')}`);
    expect(spawnSync('ls', ['-A', join(result.dir, 'wt', 'apps', 'desktop')], { encoding: 'utf8' }).stdout).toBe('package.json\ntest\n');
  });

  // The cutoff a gate computes: now minus the keep. The stamp is aged with GNU touch -d and read
  // with GNU stat, as the script needs (Linux only).
  const gnu = process.platform === 'linux';
  const sweepAt = (age: string, more = '') => `gate_desktop
touch -d '${age}' "$npm_cache/.remote-gate-since"
${more}
sweep_npm_cache $(($(date +%s) - keep_days * 86400))
if [ -d "$npm_cache" ]; then echo kept; else echo gone; fi
`;

  test.skipIf(!gnu)('the cache under the gate base goes once it is older than the keep, and not before', () => {
    const old = desktop(sweepAt('8 days ago'));
    expect(old.stdout).toContain('removed the npm cache, older than 7 days');
    expect(old.stdout).toContain('\ngone\n');
    const fresh = desktop(sweepAt('6 days ago'));
    expect(fresh.stdout).not.toContain('removed the npm cache');
    expect(fresh.stdout).toContain('\nkept\n');
  });

  test.skipIf(!gnu)('an old cache stays while another gate holds a slot, and one set outside the base always stays', () => {
    const busy = desktop(sweepAt('8 days ago', 'mkdir "$lock_dir/slot-2"'));
    expect(busy.stdout).toContain('\nkept\n');
    const elsewhere = desktop(sweepAt('8 days ago'), { REMOTE_GATE_NPM_CACHE: 'my-cache' });
    expect(elsewhere.stdout).toContain('\nkept\n');
  });

  test('a cache with no stamp yet is stamped by the sweep and aged from there', () => {
    const result = desktop(`mkdir -p "$npm_cache/_cacache"
sweep_npm_cache $(($(date +%s) - keep_days * 86400))
ls -A "$npm_cache"
`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n').sort()).toEqual(['.remote-gate-since', '_cacache']);
  });
});
