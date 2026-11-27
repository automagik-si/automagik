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
  const ghLog = join(dir, 'gh.log');
  writeFileSync(bunLog, '');
  writeFileSync(gatesLog, '');
  writeFileSync(gateLog, '');
  writeFileSync(ghLog, '');
  // Every stub logs `<folder> :: <argv>` to the gate log; the version/lane decisions are kept out of
  // it, so the gate commands are asserted in the exact order release-gates.sh ran them.
  const logCall = `printf '%s :: %s\\n' "\${PWD##*/}" "$*" >> "\${GATE_LOG:-/dev/null}"`;
  const failIfAsked = `if [[ "\${FAIL_GATE:-}" == "$*" ]]; then echo "stub: $* failed" >&2; exit 1; fi`;
  writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "\${BUN_LOG:-/dev/null}"
case "$*" in
  "scripts/lane.ts next-patch") echo "\${FAKE_CUT_VERSION:-3.0.1}"; exit 0 ;;
  "scripts/version.ts next") echo 3.0.1; exit 0 ;;
  "scripts/version.ts set "*) printf '{"version":"%s"}\\n' "$3" > package.json; exit 0 ;;
  "scripts/version.ts check") exit 0 ;;
  "scripts/lane.ts stamp-bundled-solver "*) exit 0 ;;
  "scripts/lane.ts kind "*) echo "\${FAKE_KIND:-plugins}"; exit 0 ;;
  "scripts/lane.ts herdr "*) echo "\${FAKE_HERDR:-no}"; exit 0 ;;
  "scripts/lane.ts pocket-since "*) echo v3.0.0; exit 0 ;;
  "scripts/lane.ts pocket v3.0.2") echo "\${FAKE_POCKET_SHIPS:-no}"; exit 0 ;;
  "scripts/lane.ts pocket ") echo "\${FAKE_POCKET_FROM_START:-yes}"; exit 0 ;;
  "scripts/lane.ts pocket "*) echo "\${FAKE_POCKET:-no}"; exit 0 ;;
  "scripts/lane.ts meter-since "*) echo v3.0.0; exit 0 ;;
  "scripts/lane.ts meter v3.0.2") echo "\${FAKE_METER_SHIPS:-no}"; exit 0 ;;
  "scripts/lane.ts meter ") echo "\${FAKE_METER_FROM_START:-yes}"; exit 0 ;;
  "scripts/lane.ts meter "*) echo "\${FAKE_METER:-no}"; exit 0 ;;
  "scripts/meter-lane.ts verify "*)
    [[ -f "$3" && -f "$4" && "\${FAKE_METER_VERIFY:-ok}" == ok ]] || exit 1
    pairs=$(awk '$1 == "release" && $2 == "download" && $3 == "meter-lane" && / -D / { n++ } END { print n+0 }' "\${GH_LOG}")
    (( pairs >= \${FAKE_METER_VERIFY_ON_READ:-1} )); exit $? ;;
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
echo "$*" >> "\${GH_LOG}"
case "$*" in
  "release download pocket-lane "*) part=pocket; field=versionName ;;
  "release download meter-lane "*) part=meter; field=version ;;
  "release view "*)
    tag="$3"
    apk="automagik-pocket-\${tag#v}.apk"
    if [[ -n "\${FAKE_VIEW_SECONDS:-}" ]]; then sleep "\${FAKE_VIEW_SECONDS}"; fi
    mode_var="FAKE_VIEW_MODE_\${tag//./_}"
    if [[ "\${!mode_var:-\${FAKE_VIEW_MODE:-error}}" == rate-limited ]]; then
      echo 'HTTP 429: rate limit' >&2; exit 1
    fi
    if [[ "$7" == body ]]; then
      note=''
      case "\${FAKE_VIEW_BODY:-none}" in
        pocket) printf -v note '%s%s%s' $'\x60' "$apk" $'\x60 follows' ;;
        meter) printf -v note '%s%s%s' $'usagemeter: \x60' usagemeter-darwin-arm64 $'\x60' ;;
      esac
      printf '{"body":"%s"}\\n' "$note"
      exit 0
    fi
    latest=latest.json
    prerelease=false; draft=false; published='"2026-11-19T00:00:00Z"'
    published="\${FAKE_VIEW_PUBLISHED:-$published}"
    apk_state=uploaded; latest_size=1
    case "\${!mode_var:-\${FAKE_VIEW_MODE:-error}}" in
      ok) ;;
      prerelease) prerelease=true ;;
      draft) draft=true ;;
      unpublished) published=null ;;
      no-apk) apk=other.apk ;;
      no-latest) latest=other.json ;;
      starter) apk_state=starter ;;
      zero-size) latest_size=0 ;;
      wrong-tag) tag=v3.0.0 ;;
      malformed) echo '{'; exit 0 ;;
      *) exit 1 ;;
    esac
    printf -v apk_asset '{"name":"%s","state":"%s","size":1}' "$apk" "$apk_state"
    printf -v pocket_assets '%s,{"name":"%s","state":"uploaded","size":%s}' "$apk_asset" "$latest" "$latest_size"
    meter_assets='{"name":"meter.json","state":"uploaded","size":1},{"name":"meter.json.sig","state":"uploaded","size":1}'
    case "\${FAKE_VIEW_ASSETS:-pocket}" in
      pocket) assets="$pocket_assets" ;;
      meter) assets="$meter_assets" ;;
      both) assets="$pocket_assets,$meter_assets" ;;
      apk-only) assets="$apk_asset" ;;
      none) assets='' ;;
    esac
    printf '{"tagName":"%s","isDraft":%s,"isPrerelease":%s,"publishedAt":%s,"assets":[%s]}\\n' \
      "$tag" "$draft" "$prerelease" "$published" "$assets"
    exit 0 ;;
  "api repos/owner/repo/releases/tags/pocket-lane" | "api repos/owner/repo/releases/tags/meter-lane")
    case "\${FAKE_LANE_API:-404}" in
      404) echo 'HTTP 404' >&2; exit 1 ;;
      error) echo 'HTTP 502' >&2; exit 1 ;;
      ok) printf '{"assets":%s}\\n' "\${FAKE_LANE_ASSETS:-[]}" ;;
    esac
    exit 0 ;;
  "api repos/owner/repo/releases/tags/"*)
    if [[ -n "\${FAKE_COVERAGE_SECONDS:-}" ]]; then sleep "\${FAKE_COVERAGE_SECONDS}"; fi
    [[ "\${FAKE_RELEASE_MODE:-stable}" != error ]] || exit 1
    tag="\${2##*/}"
    case "\${FAKE_RELEASE_MODE:-stable}" in
      prerelease) prerelease=true; draft=false; published='"2026-11-19T00:00:00Z"' ;;
      draft) prerelease=false; draft=true; published=null ;;
      unpublished) prerelease=false; draft=false; published=null ;;
      *) prerelease=false; draft=false; published='"2026-11-19T00:00:00Z"' ;;
    esac
    printf '{"tag_name":"%s","draft":%s,"prerelease":%s,"published_at":%s}\\n' "$tag" "$draft" "$prerelease" "$published"
    exit 0 ;;
  *) exit 0 ;;
esac
[[ "\${FAKE_POINTER_MODE:-ok}" != error ]] || exit 1
if [[ "\${FAKE_POINTER_MODE:-ok}" == malformed ]]; then echo '{'; exit 0; fi
version="\${FAKE_POINTER_VERSION:-3.0.2}"
if [[ "$part" == pocket && -n "\${FAKE_POCKET_POINTER_VERSION:-}" ]]; then version="\${FAKE_POCKET_POINTER_VERSION}"; fi
if [[ "$part" == meter && -n "\${FAKE_METER_POINTER_VERSION:-}" ]]; then version="\${FAKE_METER_POINTER_VERSION}"; fi
if [[ "$part" == pocket && -n "\${FAKE_POCKET_POINTER_SECOND:-}" ]]; then
  reads=$(awk '$1 == "release" && $2 == "download" && $3 == "pocket-lane" { n++ } END { print n+0 }' "\${GH_LOG}")
  if (( reads > 1 )); then version="\${FAKE_POCKET_POINTER_SECOND}"; fi
fi
if [[ "$part" == pocket && -n "\${FAKE_POCKET_POINTER_LATE:-}" ]]; then
  reads=$(awk '$1 == "release" && $2 == "download" && $3 == "pocket-lane" { n++ } END { print n+0 }' "\${GH_LOG}")
  if [[ "$reads" == "\${FAKE_POCKET_POINTER_FAILED_READ:-}" ]]; then exit 1; fi
  if (( reads > FAKE_POCKET_POINTER_AFTER && reads <= \${FAKE_POCKET_POINTER_LATE_UNTIL:-reads} )); then
    if [[ -n "\${FAKE_POCKET_POINTER_LATE_READ_SECONDS:-}" ]]; then sleep "\${FAKE_POCKET_POINTER_LATE_READ_SECONDS}"; fi
    version="\${FAKE_POCKET_POINTER_LATE}"
  fi
fi
if [[ "$part" == meter && -n "\${FAKE_METER_POINTER_LATE:-}" ]]; then
  reads=$(awk '$1 == "release" && $2 == "download" && $3 == "meter-lane" { n++ } END { print n+0 }' "\${GH_LOG}")
  if (( reads > FAKE_METER_POINTER_AFTER )); then
    version="\${FAKE_METER_POINTER_LATE}"
  fi
fi
if [[ "$part" == meter && "$*" == *" -D "* ]]; then
  [[ "\${FAKE_METER_DOWNLOAD:-ok}" != error ]] || exit 1
  dir="\${!#}"
  printf '{"version":"%s"}\\n' "$version" > "$dir/meter.json"
  if [[ "\${FAKE_METER_SIG:-ok}" == ok ]]; then echo signed > "$dir/meter.json.sig"; fi
elif [[ "$part" == pocket ]]; then
  if [[ -n "\${FAKE_POCKET_MANIFEST:-}" ]]; then printf '%s\\n' "$FAKE_POCKET_MANIFEST"; exit 0; fi
  code=0
  if [[ "$version" =~ ^3\\.([0-9]{1,3})\\.([0-9]{1,3})$ ]]; then
    code=$((3000000 + 1000 * 10#\${BASH_REMATCH[1]} + 10#\${BASH_REMATCH[2]}))
  fi
  printf '{"versionName":"%s","versionCode":%s,"url":"https://github.com/%s/releases/download/v%s/automagik-pocket-%s.apk","sha256":"%064d"}\\n' \
    "$version" "$code" "$5" "$version" "$version" 0
else
  printf '{"%s":"%s"}\\n' "$field" "$version"
fi
`);
  writeFileSync(join(bin, 'timeout'), `#!/usr/bin/env bash
set -euo pipefail
shift 2
if [[ "$*" == *"gh api "* && "\${FAKE_TIMEOUT_API:-}" == true ]]; then exit 124; fi
if [[ "$*" == *"gh release download"* && "\${FAKE_TIMEOUT_POINTER:-}" == true ]]; then exit 124; fi
exec "$@"
`);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'node'), 0o755);
  chmodSync(join(bin, 'shellcheck'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'timeout'), 0o755);
  writeFileSync(join(bin, 'cargo'), `#!/usr/bin/env bash
[[ "$1" == metadata ]] || exit 2
`);
  chmodSync(join(bin, 'cargo'), 0o755);
  // The scripts find the repository from their own path, so they run from this work tree. The gate
  // commands need the folders the workflow's gates run in, and the herdr-app check's install.sh.
  mkdirSync(join(work, 'scripts'));
  copyFileSync(join(root, 'scripts', 'release-cut.sh'), join(work, 'scripts', 'release-cut.sh'));
  copyFileSync(join(root, 'scripts', 'release-gates.sh'), join(work, 'scripts', 'release-gates.sh'));
  for (const app of ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'multiuser-dsh', 'vault-dsh', 'welcome-dsh']) mkdirSync(join(work, 'apps', app), { recursive: true });
  mkdirSync(join(work, 'am'));
  mkdirSync(join(work, 'herdr'));
  writeFileSync(join(work, 'herdr', 'install.sh'), '');
  mkdirSync(join(work, 'apps', 'pocket', 'android'), { recursive: true });
  writeFileSync(join(work, 'apps', 'pocket', 'android', 'gradlew'), `#!/usr/bin/env bash
printf 'android :: %s\\n' "$*" >> "\${GATE_LOG:-/dev/null}"
`);
  chmodSync(join(work, 'apps', 'pocket', 'android', 'gradlew'), 0o755);
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
        GH_LOG: ghLog,
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
    return { status: done.status, out: done.stdout, err: done.stderr, output: readFileSync(output, 'utf8'), bun: lines(bunLog), gh: lines(ghLog), gates: lines(gatesLog), gateCalls: lines(gateLog) };
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
        GH_LOG: ghLog,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_OUTPUT: output,
        ...env,
      },
    });
  };
  const tag = (name: string) => git(work, 'tag', name, 'v3.0.0');
  // A clock that moves only when the cut sleeps: `date` reads the file and `sleep` advances it, so
  // the pointer waits and the deadline boundaries do not depend on when a second ticks over. Each
  // run that uses it passes the returned path as FAKE_CUT_CLOCK.
  const clock = (start: number) => {
    const path = join(dir, 'clock');
    writeFileSync(path, `${start}\n`);
    writeFileSync(join(bin, 'date'), '#!/usr/bin/env bash\ncat "$FAKE_CUT_CLOCK"\n');
    writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nread -r now < "$FAKE_CUT_CLOCK"\nprintf "%s\\n" "$((now + $1))" > "$FAKE_CUT_CLOCK"\n');
    chmodSync(join(bin, 'date'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    return path;
  };
  return { dir, work, bin, bare, mover, run, runGates, move, remote, tag, clock, gateLog, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('a cut that dev has not moved past', () => {
  test('pushes the version commit and its tag once, and re-runs no gate', () => {
    const repo = repository();
    try {
      const run = repo.run();
      expect(run.status).toBe(0);
      expect(run.bun.filter(call => /version\.ts (set|check)|stamp-bundled-solver/.test(call))).toEqual([
        'scripts/version.ts set 3.0.1', 'scripts/version.ts check', 'scripts/lane.ts stamp-bundled-solver 3.0.1',
      ]);
      expect(run.output).toBe('version=3.0.1\nsha=' + repo.remote('rev-parse', 'refs/heads/dev') + '\npocket=no\nmeter=no\n');
      expect(run.gates).toEqual([]);
      expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('chore(release): v3.0.1');
      expect(repo.remote('rev-parse', 'refs/tags/v3.0.1^{commit}')).toBe(repo.remote('rev-parse', 'refs/heads/dev'));
    } finally {
      repo.cleanup();
    }
  });

  test('logs the one attempt and its accepted push, with no timing variables set (#1663)', () => {
    const repo = repository();
    try {
      const run = repo.run();
      expect(run.status).toBe(0);
      expect(run.err).toMatch(/::notice::Cut v3\.0\.1 attempt 1 of 3: push accepted after \d+s/);
      expect(run.err).not.toContain('Skipping retry');
    } finally {
      repo.cleanup();
    }
  });
});

describe('the cut budget (#1663)', () => {
  const now = () => Math.floor(Date.now() / 1000);

  test('a retry the budget cannot fit stops cleanly before any re-cut, with no tag', () => {
    const repo = repository();
    try {
      repo.move();
      const t = now();
      const run = repo.run({ RELEASE_CUT_STARTED: String(t - 600), RELEASE_CUT_DEADLINE: String(t + 300) });
      expect(run.status).toBe(0);
      expect(run.err).toMatch(/::notice::Cut v3\.0\.1 attempt 1 of 3: push rejected after \d+s/);
      expect(run.err).toMatch(/::notice::Skipping retry for v3\.0\.1: attempt 1 of 3 took \d+s, with -?\d+s left in the release cut budget/);
      // Not a re-cut: no lane decision, no gates, and no success output.
      expect(run.gates).toEqual([]);
      expect(run.output).toBe('');
      expect(repo.remote('tag', '--list')).toBe('v3.0.0');
      expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('fix: a merge during the cut');
      // Not the bounded-attempts outcome either: only one attempt ran.
      expect(run.out + run.err).not.toContain('on each of');
      expect(run.out).not.toContain('re-cutting');
    } finally {
      repo.cleanup();
    }
  });

  test('a retry that fits re-cuts as before and logs both attempts', () => {
    const repo = repository();
    try {
      repo.move();
      const t = now();
      const run = repo.run({ RELEASE_CUT_STARTED: String(t), RELEASE_CUT_DEADLINE: String(t + 3600) });
      expect(run.status).toBe(0);
      expect(run.out).toContain('re-cutting on the new tip (attempt 2 of 3)');
      expect(run.err).toMatch(/::notice::Cut v3\.0\.1 attempt 1 of 3: push rejected after \d+s/);
      expect(run.err).toMatch(/::notice::Cut v3\.0\.1 attempt 2 of 3: push accepted after \d+s/);
      expect(run.err).not.toContain('Skipping retry');
      expect(run.gates.length).toBe(2);
      expect(run.gates[0].startsWith('lane ')).toBe(true);
      expect(run.gates[1]).toBe('all plugins no no no');
      expect(run.output).toBe('version=3.0.1\nsha=' + repo.remote('rev-parse', 'refs/heads/dev') + '\npocket=no\nmeter=no\n');
      expect(repo.remote('log', '-1', '--format=%s', 'dev^')).toBe('fix: a merge during the cut');
      expect(repo.remote('rev-parse', 'refs/tags/v3.0.1^{commit}')).toBe(repo.remote('rev-parse', 'refs/heads/dev'));
    } finally {
      repo.cleanup();
    }
  });

  for (const [name, value] of [['RELEASE_CUT_DEADLINE', 'abc'], ['RELEASE_CUT_STARTED', 'abc']] as const) {
    test(`a ${name} that is not epoch seconds fails before any commit or tag`, () => {
      const repo = repository();
      try {
        const run = repo.run({ [name]: value });
        expect(run.status).toBe(1);
        expect(run.err).toContain(`::error::${name} must be an epoch timestamp in seconds`);
        expect(run.output).toBe('');
        expect(run.gates).toEqual([]);
        expect(repo.remote('tag', '--list')).toBe('v3.0.0');
        expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('chore: the base');
        expect(spawnSync('git', ['log', '-1', '--format=%s'], { cwd: repo.work, encoding: 'utf8' }).stdout.trim()).toBe('chore: the base');
      } finally {
        repo.cleanup();
      }
    });
  }
});

describe('a pointer that advances after the gates (#668)', () => {
  // The read counts below hold only while no second passes inside the pointer wait: a second that
  // ticks over there makes the cut re-read the pointer before it skips a build (build_is_covered),
  // one read more than these cases count. A frozen clock keeps that re-read out of them.
  const frozen = (repo: ReturnType<typeof repository>) => ({ FAKE_CUT_CLOCK: repo.clock(1_800_000_000) });

  test('Pocket and meter decide independently against a published stable tag', () => {
    const repo = repository();
    try {
      repo.tag('v3.0.2');
      const run = repo.run({ ...frozen(repo), POCKET: 'yes', METER: 'yes', POCKET_SINCE: 'v3.0.0', METER_SINCE: 'v3.0.0', FAKE_METER_SHIPS: 'yes' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\nmeter=yes\n');
      expect(run.gh.filter(call => call.startsWith('release download'))).toHaveLength(2);
      expect(run.gh.filter(call => call === 'api repos/owner/repo/releases/tags/v3.0.2')).toHaveLength(2);
      expect(run.bun).toContain('scripts/lane.ts pocket v3.0.2');
      expect(run.bun).toContain('scripts/lane.ts meter v3.0.2');
    } finally {
      repo.cleanup();
    }
  });

  test('an initially unselected lane is never re-read', () => {
    const repo = repository();
    try {
      repo.tag('v3.0.2');
      const run = repo.run({ POCKET: 'no', METER: 'yes', METER_SINCE: 'v3.0.0' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\nmeter=no\n');
      expect(run.gh.some(call => call.includes('pocket-lane'))).toBe(false);
      expect(run.gh.some(call => call.includes('meter-lane'))).toBe(true);
    } finally {
      repo.cleanup();
    }
  });

  for (const [name, env] of [
    ['shipping changes remain', { FAKE_POCKET_SHIPS: 'yes' }],
    ['the pointer is stale', { FAKE_POINTER_VERSION: '3.0.0' }],
    ['the pointer is unreadable', { FAKE_POINTER_MODE: 'malformed' }],
    ['the pointer read fails', { FAKE_POINTER_MODE: 'error' }],
    ['the pointer read times out', { FAKE_TIMEOUT_POINTER: 'true' }],
    ['the local tag is missing', { FAKE_POINTER_VERSION: '3.0.9' }],
    ['the candidate release is a prerelease', { FAKE_RELEASE_MODE: 'prerelease' }],
    ['the candidate release is unpublished', { FAKE_RELEASE_MODE: 'unpublished' }],
    ['the candidate release lookup fails', { FAKE_RELEASE_MODE: 'error' }],
    ['the candidate release lookup times out', { FAKE_TIMEOUT_API: 'true' }],
  ] as const) {
    test(`keeps Pocket selected when ${name}`, () => {
      const repo = repository();
      try {
        repo.tag('v3.0.2');
        const run = repo.run({ POCKET: 'yes', POCKET_SINCE: 'v3.0.0', ...env });
        expect(run.status).toBe(0);
        expect(run.output).toContain('pocket=yes\nmeter=no\n');
      } finally {
        repo.cleanup();
      }
    });
  }

  test('a retry publishes the decision for the checkout it actually tags', () => {
    const repo = repository();
    try {
      repo.tag('v3.0.2');
      repo.move();
      const run = repo.run({ ...frozen(repo), POCKET: 'yes', POCKET_SINCE: 'v3.0.0', FAKE_POCKET: 'yes', FAKE_POCKET_POINTER_SECOND: '3.0.0', HAS_KEYSTORE: 'true', HAS_PASSWORD: 'true' });
      expect(run.status).toBe(0);
      // The first attempt skips the build; the retry, on the tip it tags, keeps it.
      const skipped = run.out.indexOf('skipping the pocket build for this attempt');
      expect(skipped).toBeGreaterThanOrEqual(0);
      expect(run.out.indexOf('re-cutting on the new tip')).toBeGreaterThan(skipped);
      expect(run.out.match(/skipping the pocket build/g)).toHaveLength(1);
      expect(run.output).toContain('pocket=yes\nmeter=no\n');
      expect(run.gates).toContain('all plugins no yes no');
      // One lane recalculation read sits between the two post-gate rechecks.
      expect(run.gh.filter(call => call.startsWith('release download pocket-lane'))).toHaveLength(3);
      expect(run.gh.filter(call => call === 'api repos/owner/repo/releases/tags/v3.0.2')).toHaveLength(1);
      expect(repo.remote('rev-parse', 'refs/tags/v3.0.1^{commit}')).toBe(repo.remote('rev-parse', 'refs/heads/dev'));
    } finally {
      repo.cleanup();
    }
  });
});

describe('waiting for the Pocket post (#668)', () => {
  const start = 1_800_000_000;
  const pocketRead = 'release download pocket-lane --repo owner/repo -p latest.json -O -';
  const meterRead = 'release download meter-lane --repo owner/repo -p meter.json -O -';
  const view = (tag: string) => `release view ${tag} --repo owner/repo --json tagName,isDraft,isPrerelease,publishedAt,assets`;
  const coverage = (tag: string) => `api repos/owner/repo/releases/tags/${tag}`;
  const latePost = { FAKE_POCKET_POINTER_AFTER: '2', FAKE_POCKET_POINTER_LATE: '3.0.2' };

  // Advance only when the cut sleeps, so the poll and deadline boundaries are reproducible.
  function pocketPost(check: (repo: ReturnType<typeof repository>, env: Record<string, string>) => void) {
    const repo = repository();
    try {
      repo.tag('v3.0.2');
      const clock = repo.clock(start);
      check(repo, {
        POCKET: 'yes', POCKET_SINCE: 'v3.0.0', FAKE_POCKET_POINTER_VERSION: '3.0.0', FAKE_VIEW_MODE: 'ok',
        FAKE_CUT_CLOCK: clock, RELEASE_CUT_POINTER_WAIT: '28', RELEASE_CUT_POINTER_POLL: '1',
      });
    } finally {
      repo.cleanup();
    }
  }

  test('an attached Pocket build triggers the wait, and a late pointer covers the cut', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, ...latePost, METER: 'yes', METER_SINCE: 'v3.0.0', FAKE_METER_POINTER_VERSION: '3.0.0' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\nmeter=yes\n');
      expect(run.out).toContain('::notice::v3.0.2 carries its Pocket build but pocket-lane still names v3.0.0; waiting up to 28s for its post');
      expect(run.out).toContain('::notice::pocket-lane now names v3.0.2');
      expect(run.gh).toEqual([meterRead, pocketRead, view('v3.0.2'), pocketRead, pocketRead, coverage('v3.0.2')]);
    });
  });

  test('the same late post with a zero wait budget keeps the build', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, ...latePost, RELEASE_CUT_POINTER_WAIT: '0' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh).toEqual([pocketRead]);
    });
  });

  test('a failed poll can be followed by a covering pointer', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, ...latePost, FAKE_POCKET_POINTER_FAILED_READ: '2' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\n');
      expect(run.out).toContain('::notice::pocket-lane now names v3.0.2');
      expect(run.gh).toEqual([pocketRead, view('v3.0.2'), pocketRead, pocketRead, coverage('v3.0.2')]);
    });
  });

  test('a failed post with a readable stale pointer runs out of time and keeps the build', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, RELEASE_CUT_POINTER_WAIT: '27' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.out).toContain('::notice::pocket-lane still names v3.0.0 after 2s; keeping the Pocket build');
      expect(run.gh).toEqual([pocketRead, view('v3.0.2'), pocketRead]);
    });
  });

  test('the final sleep is shortened and a read without time for its timeout is skipped', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, RELEASE_CUT_POINTER_WAIT: '27', RELEASE_CUT_POINTER_POLL: '15' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.out).toContain('::notice::pocket-lane still names v3.0.0 after 2s; keeping the Pocket build');
      expect(run.gh).toEqual([pocketRead, view('v3.0.2')]);
    });
  });

  for (const mode of ['prerelease', 'draft', 'unpublished', 'no-apk', 'no-latest', 'starter', 'zero-size', 'wrong-tag', 'error', 'malformed']) {
    test(`a ${mode} candidate view keeps the build without polling`, () => {
      pocketPost((repo, env) => {
        const run = repo.run({ ...env, FAKE_VIEW_MODE: mode });
        expect(run.status).toBe(0);
        expect(run.output).toContain('pocket=yes\n');
        expect(run.gh).toEqual([pocketRead, view('v3.0.2')]);
        expect(run.bun).not.toContain('scripts/lane.ts pocket v3.0.2');
      });
    });
  }

  test('remaining Pocket changes keep the build without polling', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, FAKE_POCKET_SHIPS: 'yes' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh).toEqual([pocketRead, view('v3.0.2')]);
      expect(run.bun).toContain('scripts/lane.ts pocket v3.0.2');
    });
  });

  test('only the newest tag can trigger the wait', () => {
    pocketPost((repo, env) => {
      repo.tag('v3.0.10');
      const run = repo.run({ ...env, FAKE_VIEW_MODE: 'no-apk' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh).toEqual([pocketRead, view('v3.0.10')]);
    });
  });

  for (const [name, overrides] of [
    ['the newest tag is already the baseline', { POCKET_SINCE: 'v3.0.2' }],
    ['the newest tag predates the baseline', { POCKET_SINCE: 'v3.0.3' }],
    ['the cut is a Pocket patch', { KIND: 'pocket' }],
    ['the cut is a prerelease', { PRERELEASE: 'true' }],
    ['the initial pointer is unreadable', { FAKE_POINTER_MODE: 'malformed' }],
    ['the budget is shorter than the poll interval', { RELEASE_CUT_POINTER_POLL: '29' }],
  ] as const) {
    test(`keeps the build without looking up a release when ${name}`, () => {
      pocketPost((repo, env) => {
        const run = repo.run({ ...env, ...overrides });
        expect(run.status).toBe(0);
        expect(run.output).toContain('pocket=yes\n');
        expect(run.gh).toEqual([pocketRead]);
      });
    });
  }

  test('a cut without a repository skips the pointer check', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, GITHUB_REPOSITORY: '' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh).toEqual([]);
    });
  });

  test('an unselected Pocket build never reads the pointer or checks for a post', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, POCKET: 'no' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\n');
      expect(run.gh).toEqual([]);
    });
  });

  test('a pointer already at the newest tag goes directly to the coverage check', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, FAKE_POCKET_POINTER_VERSION: '3.0.2' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\n');
      expect(run.gh).toEqual([pocketRead, coverage('v3.0.2')]);
    });
  });

  test('a newer pointer ends the wait and still needs a local tag to cover the build', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, FAKE_POCKET_POINTER_AFTER: '1', FAKE_POCKET_POINTER_LATE: '3.0.3' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.out).toContain('::notice::pocket-lane now names v3.0.3');
      expect(run.gh).toEqual([pocketRead, view('v3.0.2'), pocketRead]);
    });
  });

  test('a long first attempt leaves too little of the deadline to wait and still retry', () => {
    pocketPost((repo, env) => {
      const run = repo.run({ ...env, ...latePost, RELEASE_CUT_STARTED: String(start - 600), RELEASE_CUT_DEADLINE: String(start + 650) });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh).toEqual([pocketRead]);
    });
  });

  for (const [name, value] of [['RELEASE_CUT_POINTER_WAIT', 'abc'], ['RELEASE_CUT_POINTER_POLL', 'abc'], ['RELEASE_CUT_POINTER_POLL', '0']] as const) {
    test(`rejects ${name}=${value} before pushing`, () => {
      pocketPost((repo, env) => {
        const run = repo.run({ ...env, [name]: value });
        expect(run.status).toBe(1);
        expect(run.err).toContain(`::error::${name} must be seconds`);
        expect(run.gh).toEqual([]);
        expect(run.output).toBe('');
        expect(repo.remote('tag', '--list')).toBe('v3.0.0');
        expect(repo.remote('log', '-1', '--format=%s', 'dev')).toBe('chore: the base');
      });
    });
  }

  test('a retry uses the remaining run budget and publishes its own Pocket decision', () => {
    pocketPost((repo, env) => {
      repo.move();
      const run = repo.run({
        ...env, RELEASE_CUT_POINTER_WAIT: '27', FAKE_POCKET_POINTER_AFTER: '1', FAKE_POCKET_POINTER_LATE: '3.0.2',
        FAKE_POCKET_POINTER_LATE_UNTIL: '2', FAKE_POCKET_POINTER_LATE_READ_SECONDS: '1',
        FAKE_POCKET: 'yes', HAS_KEYSTORE: 'true', HAS_PASSWORD: 'true',
      });
      expect(run.status).toBe(0);
      expect(run.out).toContain('skipping the pocket build for this attempt');
      expect(run.out).toContain('re-cutting on the new tip');
      expect(run.err).toContain('attempt 1 of 3: push rejected after 2s');
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh.filter(call => call.startsWith('release view'))).toEqual([view('v3.0.2')]);
      expect(run.gh.filter(call => call === pocketRead)).toHaveLength(4);
    });
  });

  test('a retry looks up the newest pushed tag after deleting the discarded tag', () => {
    pocketPost((repo, env) => {
      const pushed = spawnSync('git', ['push', '-q', 'origin', 'v3.0.2'], { cwd: repo.work, encoding: 'utf8' });
      expect(pushed.status).toBe(0);
      repo.move();
      const run = repo.run({ ...env, FAKE_CUT_VERSION: '3.0.3', FAKE_VIEW_MODE: 'error', FAKE_POCKET: 'yes', HAS_KEYSTORE: 'true', HAS_PASSWORD: 'true' });
      expect(run.status).toBe(0);
      expect(run.out).toContain('re-cutting on the new tip');
      expect(run.output).toContain('version=3.0.3\n');
      expect(run.output).toContain('pocket=yes\n');
      expect(run.gh.filter(call => call.startsWith('release view'))).toEqual([view('v3.0.2'), view('v3.0.2')]);
    });
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
      expect(run.output).toBe('version=3.0.1\nsha=' + repo.remote('rev-parse', 'refs/heads/dev') + '\npocket=no\nmeter=no\n');
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
        'multiuser-dsh :: install --frozen-lockfile --ignore-scripts',
        'vault-dsh :: install --frozen-lockfile --ignore-scripts',
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

  test('a verified cut hands a push race to the successor without gating inside the lock', () => {
    const repo = repository();
    try {
      repo.move();
      const run = repo.run({ RELEASE_CUT_ATTEMPTS: '1' });
      expect(run.status).toBe(0);
      expect(run.gates).toEqual([]);
      expect(run.output.trim()).toBe('successor=' + repo.remote('rev-parse', 'dev'));
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
        'multiuser-dsh :: install --frozen-lockfile --ignore-scripts',
        'vault-dsh :: install --frozen-lockfile --ignore-scripts',
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
      ['Which lane', 'lane'],
      ["The herdr pack's signing key", 'herdr-key'],
      ["The am lane's signing key", 'am-key'],
      ["The meter lane's signing key", 'meter-key'],
      ["Pocket's signing key is in the secrets", 'pocket-key'],
      ['Pack the add-ons the lane carries', 'addons release'],
    ];
    for (const [name, args] of calls) expect(step(name)).toContain(`run: bash scripts/release-gates.sh ${args}`);
  });

  test('the cut step calls release-cut.sh with the lane it gated and the keys a re-cut re-checks', () => {
    const cut = step('Version, commit and tag');
    expect(cut).toContain('run: bash scripts/release-cut.sh');
    for (const name of ['KIND', 'HERDR', 'POCKET', 'POCKET_SINCE', 'METER', 'METER_SINCE']) expect(cut).toContain(`${name}: \${{ steps.lane.outputs.`);
    expect(cut).toContain('RELEASE_CUT_ATTEMPTS: 1');
    expect(cut).not.toContain('secrets.');
  });

  test('release notes and downstream jobs use the successful cut flags', () => {
    expect(workflow).toContain('pocket: ${{ steps.cut.outputs.pocket }}');
    expect(workflow).toContain('meter: ${{ steps.cut.outputs.meter }}');
    const notes = step('Publish the release');
    expect(notes).toContain('POCKET: ${{ steps.cut.outputs.pocket }}');
    expect(notes).toContain('METER: ${{ steps.cut.outputs.meter }}');
    expect(workflow).toContain("needs.cut.outputs.pocket == 'yes'");
    expect(workflow).toContain("needs.cut.outputs.meter == 'yes'");
    expect(workflow).toContain('pocket_since: ${{ steps.lane.outputs.pocket_since }}');
  });

  test('the cut job starts its clock first and passes a deadline inside its timeout (#1663)', () => {
    const jobAt = workflow.indexOf('\n  cut:\n');
    expect(jobAt).toBeGreaterThan(-1);
    const nextJob = workflow.slice(jobAt + 1).search(/\n  [A-Za-z0-9_-]+:\n/);
    const job = workflow.slice(jobAt, nextJob < 0 ? undefined : jobAt + 1 + nextJob);
    const timeout = Number(job.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
    expect(timeout).toBeGreaterThan(0);
    // The first step of the job is the clock, before the checkout.
    const steps = job.slice(job.indexOf('\n    steps:\n'));
    expect(steps).toMatch(/^\n    steps:\n      - name: Start the release cut clock\n        id: clock\n/);
    const clock = step('Start the release cut clock');
    const budget = Number(clock.match(/deadline=\$\(\( started \+ (\d+) \* 60 \)\)/)?.[1]);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThan(timeout);
    expect(clock).toContain('echo "started=${started}" >> "$GITHUB_OUTPUT"');
    expect(clock).toContain('echo "deadline=${deadline}" >> "$GITHUB_OUTPUT"');
    // Without these the budget turns off silently.
    const cut = step('Version, commit and tag');
    expect(cut).toContain('RELEASE_CUT_STARTED: ${{ steps.clock.outputs.started }}');
    expect(cut).toContain('RELEASE_CUT_DEADLINE: ${{ steps.clock.outputs.deadline }}');
  });

  test('the herdr key check, the cut and the signing step select the same slot, with no fallback to the primary', () => {
    const selected = "HERDR_PACK_KEY: ${{ vars.HERDR_PACK_SIGNER == 'HERDR_PACK_KEY_NEXT' && secrets.HERDR_PACK_KEY_NEXT || vars.HERDR_PACK_SIGNER != 'HERDR_PACK_KEY_NEXT' && secrets.HERDR_PACK_KEY || '' }}";
    for (const name of ["The herdr pack's signing key", 'Sign and post the herdr lane']) {
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
      './gradlew --stacktrace :app:testGithubDebugUnitTest :app:lintGithubDebug',
      ':app:testPlayDebugUnitTest :app:lintPlayDebug',
      'bun scripts/herdr-lane.ts check-key',
      'bun scripts/am-lane.ts check-key',
      'bun scripts/meter-lane.ts check-key',
      'POCKET_SIGNING_KEYSTORE',
      'bun scripts/lane.ts pack-addons',
      'bun run check',
    ]) expect(gatesScript).toContain(command);
    // The lane decision moved into the script, every key it writes intact.
    for (const key of ['kind', 'herdr', 'pocket', 'pocket_since', 'meter', 'meter_since', 'ships', 'base']) expect(gatesScript).toContain(`echo "${key}=`);
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

describe('the shared wait for published lane posts (#668)', () => {
  const start = 1_800_000_000;
  const published = (age: number) => JSON.stringify(new Date((start - age) * 1000).toISOString().replace('.000Z', 'Z'));
  const pocketRead = 'release download pocket-lane --repo owner/repo -p latest.json -O -';
  const coverage = (tag: string) => `api repos/owner/repo/releases/tags/${tag}`;
  const views = (gh: string[]) => gh.filter(call => call.startsWith('release view') && !call.endsWith('--json body'));
  const bodies = (gh: string[]) => gh.filter(call => call.endsWith('--json body'));
  const pairs = (gh: string[]) => gh.filter(call => call.startsWith('release download meter-lane') && call.includes(' -D '));
  const pocket = { POCKET: 'yes', POCKET_SINCE: 'v3.0.0', FAKE_POCKET_POINTER_VERSION: '3.0.0' };
  const meter = { METER: 'yes', METER_SINCE: 'v3.0.0', FAKE_METER_POINTER_VERSION: '3.0.0' };
  const latePocket = { FAKE_POCKET_POINTER_AFTER: '2', FAKE_POCKET_POINTER_LATE: '3.0.2' };
  const lateMeter = { FAKE_METER_POINTER_AFTER: '1', FAKE_METER_POINTER_LATE: '3.0.2' };

  function withClock(check: (repo: ReturnType<typeof repository>, env: Record<string, string>) => void) {
    const repo = repository();
    try {
      repo.tag('v3.0.2');
      const clock = repo.clock(start);
      check(repo, { FAKE_CUT_CLOCK: clock, FAKE_VIEW_MODE: 'ok' });
    } finally {
      repo.cleanup();
    }
  }

  for (const assets of ['none', 'apk-only']) {
    test(`young Pocket notes trigger the wait with ${assets} assets`, () => {
      withClock((repo, env) => {
        const run = repo.run({
          ...env, ...pocket, ...latePocket, RELEASE_CUT_POINTER_POLL: '1',
          FAKE_VIEW_ASSETS: assets, FAKE_VIEW_BODY: 'pocket', FAKE_VIEW_PUBLISHED: published(600),
        });
        expect(run.status).toBe(0);
        expect(run.output).toContain('pocket=no\n');
        expect(run.out).toContain('v3.0.2 is still building its Pocket build');
        expect(bodies(run.gh)).toHaveLength(1);
        expect(run.gh.filter(call => call === pocketRead)).toHaveLength(3);
      });
    });
  }

  for (const [reason, age, body, bodyReads] of [
    ['notes omit Pocket', 600, 'none', 1],
    ['the release is 50 minutes old', 3000, 'pocket', 0],
  ] as const) {
    test(`a stable tag without attached assets keeps Pocket when ${reason}`, () => {
      withClock((repo, env) => {
        const run = repo.run({
          ...env, ...pocket, ...latePocket,
          FAKE_VIEW_ASSETS: 'none', FAKE_VIEW_BODY: body, FAKE_VIEW_PUBLISHED: published(age),
        });
        expect(run.status).toBe(0);
        expect(run.output).toContain('pocket=yes\n');
        expect(run.gh.filter(call => call === pocketRead)).toHaveLength(1);
        expect(bodies(run.gh)).toHaveLength(bodyReads);
        expect(run.bun).not.toContain('scripts/lane.ts pocket v3.0.2');
      });
    });
  }

  test('Pocket stops at the end of the publication window while meter keeps polling', () => {
    withClock((repo, env) => {
      const run = repo.run({
        ...env, ...pocket, ...meter, ...latePocket, ...lateMeter, FAKE_METER_POINTER_AFTER: '4',
        FAKE_VIEW_ASSETS: 'meter', FAKE_VIEW_BODY: 'pocket', FAKE_VIEW_PUBLISHED: published(2700 - 27),
        RELEASE_CUT_POINTER_WAIT: '40', RELEASE_CUT_POINTER_POLL: '1',
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\nmeter=no\n');
      expect(run.out).toContain('waiting up to 27s for its post');
      expect(run.gh.filter(call => call === pocketRead)).toHaveLength(2);
      expect(pairs(run.gh)).toHaveLength(5);
      expect(readFileSync(env.FAKE_CUT_CLOCK, 'utf8').trim()).toBe(String(start + 4));
    });
  });

  test('walks past a prerelease and a draft to the stable attachment', () => {
    withClock((repo, env) => {
      repo.tag('v3.0.4');
      repo.tag('v3.0.3');
      const run = repo.run({
        ...env, ...pocket, ...latePocket, RELEASE_CUT_POINTER_POLL: '1',
        FAKE_VIEW_MODE_v3_0_4: 'prerelease', FAKE_VIEW_MODE_v3_0_3: 'draft',
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\n');
      expect(views(run.gh).map(call => call.split(' ')[2])).toEqual(['v3.0.4', 'v3.0.3', 'v3.0.2']);
    });
  });

  test('both parts share the three-view discovery ceiling', () => {
    withClock((repo, env) => {
      for (const tag of ['v3.0.6', 'v3.0.5', 'v3.0.4', 'v3.0.3']) repo.tag(tag);
      const run = repo.run({
        ...env, ...pocket, ...meter, FAKE_VIEW_ASSETS: 'both',
        FAKE_VIEW_MODE_v3_0_6: 'prerelease', FAKE_VIEW_MODE_v3_0_5: 'draft', FAKE_VIEW_MODE_v3_0_4: 'unpublished',
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\nmeter=yes\n');
      expect(views(run.gh).map(call => call.split(' ')[2])).toEqual(['v3.0.6', 'v3.0.5', 'v3.0.4']);
      expect(bodies(run.gh)).toHaveLength(0);
    });
  });

  test('both parts share release notes and only the named meter build triggers a wait', () => {
    withClock((repo, env) => {
      const run = repo.run({
        ...env, ...pocket, ...meter, ...lateMeter, RELEASE_CUT_POINTER_POLL: '1',
        FAKE_VIEW_ASSETS: 'none', FAKE_VIEW_BODY: 'meter', FAKE_VIEW_PUBLISHED: published(600),
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\nmeter=no\n');
      expect(run.out).toContain('v3.0.2 is still building its meter build');
      expect(views(run.gh)).toHaveLength(1);
      expect(bodies(run.gh)).toHaveLength(1);
      expect(run.gh.filter(call => call === pocketRead)).toHaveLength(1);
    });
  });

  test('a rate-limited view stops optional calls for both parts', () => {
    withClock((repo, env) => {
      repo.tag('v3.0.3');
      const run = repo.run({ ...env, ...pocket, ...meter, FAKE_VIEW_MODE_v3_0_3: 'rate-limited' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\nmeter=yes\n');
      expect(run.gh).toHaveLength(3);
      expect(views(run.gh).map(call => call.split(' ')[2])).toEqual(['v3.0.3']);
      expect(readFileSync(env.FAKE_CUT_CLOCK, 'utf8').trim()).toBe(String(start));
    });
  });

  for (const [name, verify, verifyOnRead, expected, pairReads] of [
    ['a verified pair', 'ok', '1', 'no', 2],
    ['a torn pair that verifies on the next poll', 'ok', '2', 'no', 3],
    ['a pair that never verifies', 'fail', '1', 'yes', 3],
  ] as const) {
    test(`an attached meter build with ${name} leaves meter=${expected}`, () => {
      withClock((repo, env) => {
        const run = repo.run({
          ...env, ...meter, ...lateMeter, FAKE_VIEW_ASSETS: 'meter',
          FAKE_METER_VERIFY: verify, FAKE_METER_VERIFY_ON_READ: verifyOnRead,
          RELEASE_CUT_POINTER_WAIT: '29', RELEASE_CUT_POINTER_POLL: '1',
        });
        expect(run.status).toBe(0);
        expect(run.output).toContain(`meter=${expected}\n`);
        expect(pairs(run.gh)).toHaveLength(pairReads);
        expect(run.bun.filter(call => call.startsWith('scripts/meter-lane.ts verify '))).toHaveLength(pairReads);
      });
    });
  }

  test('the default 300-second wait picks up both posts in one loop', () => {
    withClock((repo, env) => {
      const run = repo.run({ ...env, ...pocket, ...meter, ...latePocket, ...lateMeter, FAKE_VIEW_ASSETS: 'both' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\nmeter=no\n');
      expect(run.out.match(/waiting up to 300s for its post/g)).toHaveLength(2);
      expect(views(run.gh)).toHaveLength(1);
      expect(run.gh.indexOf(pocketRead)).toBe(1);
      expect(pairs(run.gh)).toHaveLength(2);
      expect(readFileSync(env.FAKE_CUT_CLOCK, 'utf8').trim()).toBe(String(start + 30));
    });
  });

  test('an intermediate covering pointer ends the wait before the candidate posts', () => {
    withClock((repo, env) => {
      repo.tag('v3.0.3');
      const run = repo.run({ ...env, ...pocket, ...latePocket, RELEASE_CUT_POINTER_POLL: '1' });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=no\n');
      expect(run.out).toContain('pocket-lane now names v3.0.2');
      expect(run.gh.filter(call => call === pocketRead)).toHaveLength(3);
      expect(readFileSync(env.FAKE_CUT_CLOCK, 'utf8').trim()).toBe(String(start + 2));
    });
  });

  test('a slow view cannot start a body lookup without time for its timeout', () => {
    withClock((repo, env) => {
      const run = repo.run({
        ...env, ...pocket, FAKE_VIEW_SECONDS: '20', FAKE_VIEW_ASSETS: 'none',
        FAKE_VIEW_BODY: 'pocket', FAKE_VIEW_PUBLISHED: published(600), RELEASE_CUT_POINTER_WAIT: '45',
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\n');
      expect(views(run.gh)).toHaveLength(1);
      expect(bodies(run.gh)).toHaveLength(0);
    });
  });

  test('re-reads an unpolled pointer before allowing it to cover after the wait', () => {
    withClock((repo, env) => {
      const run = repo.run({
        ...env, ...pocket, ...meter, ...lateMeter, FAKE_VIEW_ASSETS: 'meter',
        FAKE_POCKET_POINTER_VERSION: '3.0.2', FAKE_POCKET_POINTER_SECOND: '3.0.0',
        RELEASE_CUT_POINTER_POLL: '1',
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\nmeter=no\n');
      expect(run.gh.filter(call => call === pocketRead)).toHaveLength(2);
      expect(run.gh.at(-1)).toBe(pocketRead);
    });
  });

  test('a final meter verification retry also refreshes an unpolled Pocket pointer', () => {
    withClock((repo, env) => {
      const run = repo.run({
        ...env, ...pocket, ...meter, FAKE_METER_POINTER_VERSION: '3.0.2', FAKE_METER_VERIFY_ON_READ: '2',
        FAKE_POCKET_POINTER_VERSION: '3.0.2', FAKE_POCKET_POINTER_SECOND: '3.0.0',
        RELEASE_CUT_POINTER_WAIT: '28', RELEASE_CUT_POINTER_POLL: '1',
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\nmeter=no\n');
      expect(views(run.gh)).toHaveLength(0);
      expect(pairs(run.gh)).toHaveLength(2);
      expect(run.gh.filter(call => call === pocketRead)).toHaveLength(2);
    });
  });

  for (const [delay, expected] of [[73, 'admitted'], [77, 'skipped']] as const) {
    test(`a retry is ${expected} after discounting slow discovery and counting mandatory coverage`, () => {
      withClock((repo, env) => {
        repo.move();
        const git = join(repo.bin, 'git');
        writeFileSync(git, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == push && ! -f "$FAKE_CUT_CLOCK.push" ]]; then
  touch "$FAKE_CUT_CLOCK.push"
  sleep ${delay}
fi
exec ${JSON.stringify(Bun.which('git'))} "$@"
`);
        chmodSync(git, 0o755);
        const run = repo.run({
          ...env, ...pocket, ...latePocket, FAKE_POCKET_POINTER_LATE_UNTIL: '3',
          FAKE_VIEW_SECONDS: '20', FAKE_COVERAGE_SECONDS: '20', RELEASE_CUT_POINTER_POLL: '1',
          RELEASE_CUT_STARTED: String(start - 40), RELEASE_CUT_DEADLINE: String(start + 250),
          FAKE_POCKET: 'yes', HAS_KEYSTORE: 'true', HAS_PASSWORD: 'true',
        });
        expect(run.status).toBe(0);
        expect(run.out).toContain('waiting up to 30s for its post');
        expect(run.err).toContain(`push rejected after ${82 + delay}s`);
        if (expected === 'admitted') {
          expect(run.out).toContain('re-cutting on the new tip');
          expect(run.output).toContain('pocket=yes\n');
        } else {
          expect(run.err).toContain('131s left in the release cut budget (longest attempt: 137s)');
          expect(run.output).toBe('');
        }
      });
    });
  }

  for (const [name, overrides, expected, pairReads] of [
    ['unverifiable pair', { FAKE_METER_VERIFY: 'fail' }, 'yes', 1],
    ['missing signature', { FAKE_METER_SIG: 'missing' }, 'yes', 1],
    ['verified version without a local tag', { FAKE_METER_POINTER_LATE: '3.0.9', FAKE_METER_POINTER_AFTER: '1' }, 'yes', 1],
    ['verified version with a local covering tag', { FAKE_METER_POINTER_LATE: '3.0.3', FAKE_METER_POINTER_AFTER: '1' }, 'no', 1],
    ['verified pair', {}, 'no', 1],
    ['pair that verifies on retry', { FAKE_METER_VERIFY_ON_READ: '2', RELEASE_CUT_POINTER_WAIT: '28' }, 'no', 2],
    ['pair without time for a retry', { FAKE_METER_VERIFY_ON_READ: '2', RELEASE_CUT_POINTER_WAIT: '45', FAKE_COVERAGE_SECONDS: '20' }, 'yes', 1],
  ] as const) {
    test(`final meter coverage with a ${name} leaves meter=${expected}`, () => {
      withClock((repo, env) => {
        if (overrides.FAKE_METER_POINTER_LATE === '3.0.3') repo.tag('v3.0.3');
        const run = repo.run({
          ...env, ...meter, FAKE_METER_POINTER_VERSION: '3.0.2',
          RELEASE_CUT_POINTER_WAIT: '0', RELEASE_CUT_POINTER_POLL: '1', ...overrides,
        });
        expect(run.status).toBe(0);
        expect(run.output).toContain(`meter=${expected}\n`);
        expect(pairs(run.gh)).toHaveLength(pairReads);
        if (overrides.FAKE_METER_POINTER_LATE === '3.0.3') {
          expect(run.gh).toContain(coverage('v3.0.3'));
          expect(run.out).toContain('meter-lane advanced to v3.0.3 and covers this checkout');
        }
      });
    });
  }
});

describe('lane repair on a plugin-only release (#668)', () => {
  const asset = (name: string) => ({ name, state: 'uploaded' });
  const pocketAsset = asset('latest.json');
  const meterAssets = [asset('meter.json'), asset('meter.json.sig')];
  const producerManifest = {
    versionName: '3.0.2',
    versionCode: 3000002,
    url: 'https://github.com/owner/repo/releases/download/v3.0.2/automagik-pocket-3.0.2.apk',
    sha256: 'a'.repeat(64),
  };

  function lane(repo: ReturnType<typeof repository>, env: Record<string, string>) {
    const sleep = join(repo.bin, 'sleep');
    writeFileSync(sleep, '#!/usr/bin/env bash\nprintf "%s\\n" "$1" >> "$FAKE_LANE_SLEEP_LOG"\n');
    chmodSync(sleep, 0o755);
    const sleepLog = join(repo.dir, 'lane-sleep.log');
    writeFileSync(sleepLog, '');
    const done = repo.runGates(['lane'], {
      FAKE_POCKET_POINTER_VERSION: '3.0.0', FAKE_METER_POINTER_VERSION: '3.0.0',
      FAKE_LANE_SLEEP_LOG: sleepLog, ...env,
    });
    return {
      ...done, output: readFileSync(join(repo.dir, 'gates-output'), 'utf8'),
      gh: readFileSync(join(repo.dir, 'gh.log'), 'utf8').trim().split('\n'),
      sleeps: readFileSync(sleepLog, 'utf8').trim().split('\n').filter(Boolean),
    };
  }

  for (const [mode, expected, probes] of [
    ['ok', 'pocket=yes\npocket_since=\n', 1],
    ['404', 'pocket=no\npocket_since=v3.0.0\n', 1],
    ['error', 'pocket=yes\npocket_since=\n', 3],
  ] as const) {
    test(`Pocket repair handles a ${mode} lane probe`, () => {
      const repo = repository();
      try {
        const run = lane(repo, { FAKE_LANE_API: mode, FAKE_POCKET_MANIFEST: '{}' });
        expect(run.status).toBe(0);
        expect(run.output).toContain('kind=plugins\n');
        expect(run.output).toContain(expected);
        expect(run.gh.filter(call => call.endsWith('/pocket-lane'))).toHaveLength(probes);
        expect(run.sleeps).toEqual(mode === 'error' ? ['5', '5'] : []);
        if (mode === 'error') expect(run.stderr).toContain('::warning::could not check pocket-lane after three attempts');
        if (mode !== '404') expect(run.stdout).toContain('pocket-lane has no readable latest.json');
      } finally {
        repo.cleanup();
      }
    });
  }

  for (const [name, field] of [
    ['leading zero in versionName', { versionName: '3.00.2' }],
    ['versionCode mismatch', { versionCode: 3000003 }],
    ['wrong repository URL', { url: producerManifest.url.replace('owner/repo', 'other/repo') }],
    ['uppercase hash', { sha256: 'A'.repeat(64) }],
  ] as const) {
    test(`a Pocket manifest with ${name} is unusable in both scripts`, () => {
      const repo = repository();
      try {
        repo.tag('v3.0.2');
        const FAKE_POCKET_MANIFEST = JSON.stringify({ ...producerManifest, ...field });
        const cut = repo.run({ POCKET: 'yes', POCKET_SINCE: 'v3.0.0', FAKE_POCKET_MANIFEST });
        expect(cut.status).toBe(0);
        expect(cut.output).toContain('pocket=yes\n');
        expect(cut.gh).toHaveLength(1);
        const run = lane(repo, { FAKE_POCKET_MANIFEST, FAKE_LANE_API: 'ok', FAKE_LANE_ASSETS: JSON.stringify([pocketAsset]) });
        expect(run.status).toBe(0);
        expect(run.output).toContain('pocket=yes\npocket_since=\n');
        expect(run.stdout).toContain('pocket-lane has no readable latest.json');
      } finally {
        repo.cleanup();
      }
    });
  }

  test('Pocket repairs a valid manifest whose version has no local tag', () => {
    const repo = repository();
    try {
      const run = lane(repo, {
        FAKE_POCKET_MANIFEST: JSON.stringify(producerManifest),
        FAKE_LANE_API: 'ok', FAKE_LANE_ASSETS: JSON.stringify([pocketAsset]),
      });
      expect(run.status).toBe(0);
      expect(run.output).toContain('pocket=yes\npocket_since=\n');
      expect(run.gh).toContain('api repos/owner/repo/releases/tags/pocket-lane');
    } finally {
      repo.cleanup();
    }
  });

  for (const [name, mode, assets, overrides, result, notice] of [
    ['empty lane', 'ok', [], { FAKE_METER_SIG: 'missing' }, 'meter=yes\nmeter_since=\n', '::notice::meter-lane has no pointer; this release posts a new pointer'],
    ['missing signature asset', 'ok', meterAssets.slice(0, 1), { FAKE_METER_SIG: 'missing' }, 'meter=yes\nmeter_since=\n', '::warning::meter-lane has an incomplete or unreadable pointer'],
    ['unverifiable pair', 'ok', meterAssets, { FAKE_METER_VERIFY: 'fail' }, 'meter=yes\nmeter_since=\n', '::warning::meter-lane has an incomplete or unreadable pointer'],
    ['failed download with both assets', 'ok', meterAssets, { FAKE_METER_DOWNLOAD: 'error' }, 'meter=yes\nmeter_since=\n', '::warning::meter-lane has an incomplete or unreadable pointer'],
    ['indeterminate lane probe', 'error', [], { FAKE_METER_DOWNLOAD: 'error' }, 'meter=yes\nmeter_since=\n', '::warning::could not check meter-lane after three attempts'],
    ['bootstrap', '404', [], { FAKE_METER_DOWNLOAD: 'error' }, 'meter=no\nmeter_since=v3.0.0\n', ''],
    ['held meter', 'ok', [], { FAKE_METER_SIG: 'missing', FAKE_METER_FROM_START: 'no' }, 'meter=no\nmeter_since=\n', '::notice::meter-lane has no pointer'],
  ] as const) {
    test(`meter repair measures the right baseline for a ${name}`, () => {
      const repo = repository();
      try {
        const run = lane(repo, { FAKE_LANE_API: mode, FAKE_LANE_ASSETS: JSON.stringify(assets), ...overrides });
        expect(run.status).toBe(0);
        expect(run.output).toContain('kind=plugins\n');
        expect(run.output).toContain(result);
        expect(run.gh.filter(call => call.endsWith('/meter-lane'))).toHaveLength(mode === 'error' ? 3 : 1);
        expect(run.sleeps).toEqual(mode === 'error' ? ['5', '5'] : []);
        if (notice) expect(run.stdout + run.stderr).toContain(notice);
        if (notice.includes('incomplete')) expect(run.stdout).toContain('the post refuses it unless dispatched with replace_unverified_meter_pointer');
      } finally {
        repo.cleanup();
      }
    });
  }
});

describe('release notes and the lane post windows (#668)', () => {
  test('the published notes announce both builds with the cut’s search text', () => {
    const note = (part: string) => workflow.split('\n').find(line => line.includes('"${' + part + '}"') && line.includes('notes="${notes}')) ?? '';
    const pocketNote = '`automagik-pocket-${VERSION}.apk` follows';
    const meterNote = 'usagemeter: `usagemeter-darwin-arm64`';
    expect(note('POCKET').replaceAll('\\`', '`')).toContain(pocketNote);
    expect(note('METER').replaceAll('\\`', '`')).toContain(meterNote);
    const searched = cutScript.replaceAll('\\`', '`');
    expect(searched).toContain('`${asset}` follows');
    expect(searched).toContain(meterNote);
  });

  test('the post windows cover each producing job and five additional minutes', () => {
    function timeoutMinutes(job: string) {
      const jobBody = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
      const minutes = Number(jobBody?.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
      expect(minutes).toBeGreaterThan(0);
      return minutes;
    }
    for (const [part, jobs] of [
      ['pocket', ['pocket', 'pocket-lane']],
      ['meter', ['meter', 'meter-attach', 'meter-lane']],
    ] as const) {
      const window = Number(cutScript.match(new RegExp(`^${part}_post_window=(\\d+)$`, 'm'))?.[1]);
      expect(window).toBeGreaterThanOrEqual((5 + jobs.reduce((sum, job) => sum + timeoutMinutes(job), 0)) * 60);
    }
  });
});
