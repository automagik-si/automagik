// The release workflows' shell, run as written with a fake gh: the desktop build keeps the cut's
// signed lane on the release, the cut retries the lane's upload to its versioned release, the cut
// publishes with flags that add up (a prerelease plugin or herdr patch stays a prerelease), the
// cut's decision to release at all is the diff's rather than the subjects' (#767), and the cut
// posts the herdr lane and the am lane blind only when nothing is posted yet, and every release
// packs am and checks am's key before it tags.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pluginNames } from './release-plugins';

const workflow = (name: string) => readFileSync(join(import.meta.dir, '..', '.github', 'workflows', name), 'utf8').split('\n');

function bash(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const run = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`, 'bash', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { status: run.status, out: run.stdout, err: run.stderr };
}

// The `run: |` block of the step named `name`, dedented.
function runOf(lines: string[], name: string): string {
  const at = lines.findIndex(line => line.trim() === `- name: ${name}`);
  if (at < 0) return '';
  const run = lines.findIndex((line, i) => i > at && line.trim() === 'run: |');
  if (run < 0) return '';
  const base = lines[run].length - lines[run].trimStart().length;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= base) break;
    body.push(line);
  }
  const by = Math.min(...body.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length));
  return body.map(line => line.slice(by)).join('\n');
}

// A fake gh: `release view` answers the feeds (or says the release is missing), `workflow run`
// logs the dispatch, and every call is recorded.
function fakeGh(options: { feeds?: string[]; missing?: boolean; failView?: string; failDispatch?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-retry-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'gh.log');
  const feeds = join(dir, 'feeds');
  writeFileSync(log, '');
  writeFileSync(feeds, (options.feeds ?? []).map(name => `${name}\n`).join(''));
  const script = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `echo "$*" >> "${log}"`,
    'case "$*" in',
    '  *"release view v9.9.9"*)',
    options.missing || options.failView ? `    echo ${JSON.stringify(options.failView ?? 'release not found')} >&2; exit 1` : '    :',
    '    case "$*" in',
    `      *"--json assets"*) cat "${feeds}" ;;`,
    '    esac',
    '    ;;',
    '  *"workflow run desktop-build.yml"*)',
    options.failDispatch ? '    exit 1' : '    :',
    '    ;;',
    '  *) echo "unexpected gh: $*" >&2; exit 64 ;;',
    'esac',
  ].join('\n');
  writeFileSync(join(bin, 'gh'), script);
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    run: (script: string, env: Record<string, string> = {}) => bash(script, [], { PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'owner/repo', VERSION: '9.9.9', TAG: 'v9.9.9', PRERELEASE: 'false', ...env }),
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('the desktop build adding its files to an existing release', () => {
  const lines = workflow('desktop-build.yml');
  const step = lines.findIndex(line => line.includes('name: Add the builds to the release'));
  const keep = lines.slice(step).find(line => /^\s*case "\$\{name\}" in .*\) continue ;; esac$/.test(line));

  test('keeps the cut\'s own files and its signed lane, and lets the rest go', () => {
    expect(step).toBeGreaterThan(-1);
    expect(keep).toBeDefined();
    const names = ['lane.json', 'lane.json.sig', 'automagik-bots-dsh-9.9.9.tgz', 'plugins.json', 'PLUGINS.SHA256SUMS', 'Automagik-9.9.9-arm64.dmg', 'lane.json.old',
      'usagemeter-darwin-arm64', 'usagemeter-darwin-x86_64', 'usagemeter-linux-x86_64', 'usagemeter-linux-aarch64', 'usagemeter.SHA256SUMS', 'meter.json', 'meter.json.sig', 'SHA256SUMS'];
    const run = bash(`for name in "$@"; do\n${keep}\necho "\${name}"\ndone`, names);
    expect(run.status).toBe(0);
    // The meter's binaries, their sums and signed pointer are the meter jobs' own (release.yml): spared.
    expect(run.out.trim().split('\n')).toEqual(['Automagik-9.9.9-arm64.dmg', 'lane.json.old', 'SHA256SUMS']);
  });
});

describe('the desktop publish refusing a second feed', () => {
  const lines = workflow('desktop-build.yml');
  const parsed = Bun.YAML.parse(lines.join('\n')) as any;
  const guard = runOf(lines, 'Never a second feed');

  test('is a real step, skipped only by a deliberate rebuild, and one publish per version', () => {
    expect(guard).toContain('already carries');
    expect(guard).toContain('replace=true');
    const step = lines.findIndex(line => line.trim() === '- name: Never a second feed');
    expect(lines.slice(step, step + 4).map(line => line.trim())).toContain('if: ${{ inputs.replace != true }}');
    expect(parsed.jobs.release.concurrency).toEqual({ group: 'desktop-publish-${{ needs.version.outputs.version }}', 'cancel-in-progress': false });
    expect(parsed.on.workflow_call.inputs.replace.default).toBe(false);
    expect(parsed.on.workflow_dispatch.inputs.replace.default).toBe(false);
  });

  test('a release that already carries a feed is refused, naming it and the way past', () => {
    const gh = fakeGh({ feeds: ['latest-mac.yml'] });
    try {
      const run = gh.run(guard);
      expect(run.status).toBe(1);
      expect(run.out).toContain('v9.9.9 already carries latest-mac.yml');
      expect(run.out).toContain('replace=true');
      expect(gh.calls()).toEqual(['release view v9.9.9 --repo owner/repo --json assets --jq .assets[].name']);
    } finally {
      gh.cleanup();
    }
  });

  test('no feed publishes, and a release that does not exist yet is created by this build', () => {
    const clean = fakeGh({ feeds: [] });
    try {
      const run = clean.run(guard);
      expect(run.status).toBe(0);
      expect(run.out).toContain('v9.9.9 carries no desktop feed: publishing');
    } finally {
      clean.cleanup();
    }
    const missing = fakeGh({ missing: true });
    try {
      const run = missing.run(guard);
      expect(run.status).toBe(0);
      expect(run.out).toContain('v9.9.9 does not exist yet: this build creates it');
    } finally {
      missing.cleanup();
    }
  });

  test('any other failed read stops the publish: no feed is assumed from an API error', () => {
    const gh = fakeGh({ failView: 'HTTP 500: server error' });
    try {
      const run = gh.run(guard);
      expect(run.status).toBe(1);
      expect(run.out).toContain('::error ::could not read v9.9.9: HTTP 500: server error');
    } finally {
      gh.cleanup();
    }
  });
});

describe('the desktop publish retry', () => {
  const lines = workflow('release.yml');
  const parsed = Bun.YAML.parse(lines.join('\n')) as any;
  const retry = runOf(lines, 'Dispatch one rebuild when the release has no feed');
  const dispatch = 'workflow run desktop-build.yml --repo owner/repo --ref dev -f ref=v9.9.9 -f publish=true -f replace=false -f prerelease=false';

  test('runs only for a failed desktop job on a cut version, after the cut', () => {
    expect(parsed.jobs['desktop-retry'].needs).toEqual(['cut', 'desktop']);
    expect(parsed.jobs['desktop-retry'].if).toContain('!cancelled()');
    expect(parsed.jobs['desktop-retry'].if).toContain("needs.cut.outputs.version != ''");
    expect(parsed.jobs['desktop-retry'].if).toContain("needs.desktop.result == 'failure'");
  });

  test('no feed: one dispatch for the same tag, with replace=false', () => {
    const gh = fakeGh({ feeds: [] });
    try {
      const run = gh.run(retry);
      expect(run.status).toBe(0);
      expect(gh.calls().at(-1)).toBe(dispatch);
      expect(run.out).toContain('dispatched desktop-build.yml for v9.9.9');
    } finally {
      gh.cleanup();
    }
  });

  test('a feed already there: no second build', () => {
    const gh = fakeGh({ feeds: ['latest-linux.yml'] });
    try {
      const run = gh.run(retry);
      expect(run.status).toBe(0);
      expect(gh.calls().some(call => call.startsWith('workflow run'))).toBe(false);
      expect(run.out).toContain('already carries a desktop feed');
    } finally {
      gh.cleanup();
    }
  });

  test('a missing release or a refused dispatch fails the retry, never a silent skip', () => {
    const missing = fakeGh({ missing: true });
    try {
      const run = missing.run(retry);
      expect(run.status).toBe(1);
      expect(run.out).toContain('::error ::could not read v9.9.9: release not found');
      expect(missing.calls().some(call => call.startsWith('workflow run'))).toBe(false);
    } finally {
      missing.cleanup();
    }
    const refused = fakeGh({ feeds: [], failDispatch: true });
    try {
      expect(refused.run(retry).status).toBe(1);
    } finally {
      refused.cleanup();
    }
    const unreadable = fakeGh({ failView: 'HTTP 500: server error' });
    try {
      const run = unreadable.run(retry);
      expect(run.status).toBe(1);
      expect(run.out).toContain('::error ::could not read v9.9.9: HTTP 500: server error');
      expect(unreadable.calls().some(call => call.startsWith('workflow run'))).toBe(false);
    } finally {
      unreadable.cleanup();
    }
  });
});

describe('the cut uploading its signed lane to the versioned release', () => {
  const lines = workflow('release.yml');
  const upload = lines.findIndex(line => line.includes('until gh release upload "v${VERSION}" lane/lane.json lane/lane.json.sig'));
  const end = lines.findIndex((line, i) => i > upload && line.trim() === 'done');
  const block = upload > 0 && lines[upload - 1].trim() === 'tries=0' ? lines.slice(upload - 1, end + 1).join('\n') : '';

  // gh fails its first `fails` calls; gh and sleep each log their arguments.
  function cut(fails: number) {
    const dir = mkdtempSync(join(tmpdir(), 'release-upload-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nn=$(wc -l < "${dir}/gh.log")\n(( n > ${fails} ))\n`);
    writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/sleep.log"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'sleep'), 0o755);
    const run = bash(block, [], { PATH: `${bin}:${process.env.PATH ?? ''}`, VERSION: '9.9.9', GITHUB_REPOSITORY: 'owner/repo' });
    const log = (name: string) => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
    const result = { ...run, gh: log('gh.log'), sleeps: log('sleep.log') };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  const call = 'release upload v9.9.9 lane/lane.json lane/lane.json.sig --repo owner/repo';

  test('is found as the step writes it', () => {
    expect(block).not.toBe('');
  });

  test('one good upload: no wait, never --clobber', () => {
    const run = cut(0);
    expect(run.status).toBe(0);
    expect(run.gh).toEqual([call]);
    expect(run.sleeps).toEqual([]);
  });

  test('two transient errors: the third try goes up, 10 s and then 20 s later', () => {
    const run = cut(2);
    expect(run.status).toBe(0);
    expect(run.gh).toEqual([call, call, call]);
    expect(run.sleeps).toEqual(['10', '20']);
  });

  test('three errors: the cut fails loudly, naming the tag and both files', () => {
    const run = cut(3);
    expect(run.status).toBe(1);
    expect(run.gh).toEqual([call, call, call]);
    expect(run.sleeps).toEqual(['10', '20']);
    expect(run.out).toContain('::error::lane/lane.json and lane/lane.json.sig did not reach v9.9.9 after 3 tries');
  });
});

describe('commitlint over a pull request that imports a repository with its history', () => {
  const lines = workflow('commitlint.yml');
  const start = lines.findIndex(line => line.trim() === 'run: |');
  const script = start > 0 ? lines.slice(start + 1).map(line => line.replace(/^ {10}/, '')).join('\n') : '';
  const long = (what: string) => `${what} ${'x'.repeat(90)}`;

  // A repository whose dev is `base`; `steps` builds a pull request branch `pr` on it. `upstream`
  // is the imported repository's history (an orphan, as filter-repo leaves it), which the steps
  // grow and merge in as scripts/import-herdr.sh does.
  function lint(steps: (git: (...args: string[]) => string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'commitlint-'));
    const git = (...args: string[]) => {
      const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
      return run.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'dev');
      git('commit', '-q', '--allow-empty', '-m', 'chore: the base');
      git('checkout', '-q', '--orphan', 'upstream');
      git('commit', '-q', '--allow-empty', '-m', long('docs(old): a line the old repository allowed'));
      git('commit', '-q', '--allow-empty', '-m', 'An old subject that is not conventional');
      git('checkout', '-q', '-b', 'pr', 'dev');
      steps(git);
      const run = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', BASE: git('rev-parse', 'dev'), HEAD: git('rev-parse', 'pr') } });
      return { status: run.status, out: run.stdout + run.stderr };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const importIt = (git: (...args: string[]) => string) => git('merge', '-q', '--no-ff', '--allow-unrelated-histories', '-m', 'feat(herdr): import it', 'upstream');
  const commit = (git: (...args: string[]) => string, subject: string) => git('commit', '-q', '--allow-empty', '-m', subject);

  test('the script skips only what an import merge\'s second parent brought', () => {
    expect(script).toContain('git merge-base --is-ancestor "${root}" "${merge}^2"');
    expect(script).toContain('git rev-list --no-merges "${merge}^2" --not "${merge}^1" "${BASE}"');
  });

  test('the first import: its history is skipped; the pull request\'s own commits are checked', () => {
    const ok = lint(git => { commit(git, 'chore(herdr): add the import script'); importIt(git); commit(git, 'ci(herdr): run the pack here'); });
    expect(ok.out).toContain('2 imported commit(s) skipped');
    expect(ok.status).toBe(0);
    const bad = lint(git => { importIt(git); commit(git, long('fix: a commit of this pull request')); });
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('has a line over 100 characters');
    expect(bad.out).not.toContain('is not conventional');
  });

  test('the final re-run adds a second import merge: only its new upstream commits are skipped', () => {
    const rerun = (own: string) => lint(git => {
      importIt(git);
      commit(git, 'feat(herdr): point the pack here');
      git('checkout', '-q', 'upstream');
      commit(git, long('fix(old): a newer upstream commit'));
      git('checkout', '-q', 'pr');
      git('merge', '-q', '--no-ff', '-m', 'feat(herdr): import it again', 'upstream');
      commit(git, own);
    });
    const ok = rerun('fix(herdr): resolve the re-import');
    expect(ok.out).toContain('3 imported commit(s) skipped');
    expect(ok.status).toBe(0);
    const bad = rerun('fixed the re-import');
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('is not conventional: fixed the re-import');
  });

  test('other merges skip nothing: dev merged in, or a branch of this repository merged with --no-ff', () => {
    const devMoves = lint(git => {
      importIt(git);
      commit(git, long('fix: a commit of this pull request'));
      git('checkout', '-q', 'dev');
      commit(git, 'chore(release): v9.9.9');
      git('checkout', '-q', 'pr');
      git('merge', '-q', '--no-ff', '-m', 'chore: merge dev', 'dev');
    });
    expect(devMoves.status).toBe(1);
    expect(devMoves.out).toContain('has a line over 100 characters');
    expect(devMoves.out).toContain('2 imported commit(s) skipped');
    const side = lint(git => {
      git('checkout', '-q', '-b', 'side', 'dev');
      commit(git, 'wip on a side branch');
      git('checkout', '-q', 'pr');
      git('merge', '-q', '--no-ff', '-m', 'chore: merge side', 'side');
    });
    expect(side.status).toBe(1);
    expect(side.out).toContain('is not conventional: wip on a side branch');
    expect(side.out).not.toContain('skipped');
  });
});

describe('the cut choosing how to publish its release', () => {
  const lines = workflow('release.yml');
  const step = lines.findIndex(line => line.includes('name: Publish the release'));
  const start = lines.findIndex((line, i) => i > step && line.trim() === 'flags=()');
  const end = lines.findIndex((line, i) => i > start && line.trim().startsWith('gh release create "v${VERSION}"'));
  const block = step > -1 && start > step && end > start ? lines.slice(start, end).join('\n') : '';

  const flags = (env: { PRERELEASE: string; KIND: string }) => {
    const run = bash(`${block}\nprintf '%s\\n' "\${flags[@]}"`, [], env);
    expect(run.status).toBe(0);
    return run.out.trim().split('\n');
  };

  test('is found as the step writes it', () => {
    expect(block).not.toBe('');
  });

  test('a full stable release is Latest', () => {
    expect(flags({ PRERELEASE: 'false', KIND: 'full' })).toEqual(['--latest']);
  });

  test('a push-triggered release (no prerelease input) is Latest', () => {
    expect(flags({ PRERELEASE: '', KIND: 'full' })).toEqual(['--latest']);
  });

  test('a full prerelease is a prerelease, not Latest', () => {
    expect(flags({ PRERELEASE: 'true', KIND: 'full' })).toEqual(['--prerelease', '--latest=false']);
  });

  test('a plugin patch is not Latest', () => {
    expect(flags({ PRERELEASE: 'false', KIND: 'plugins' })).toEqual(['--latest=false']);
  });

  test('a prerelease plugin patch stays a prerelease', () => {
    expect(flags({ PRERELEASE: 'true', KIND: 'plugins' })).toEqual(['--prerelease', '--latest=false']);
  });

  test('a herdr patch is not Latest', () => {
    expect(flags({ PRERELEASE: 'false', KIND: 'herdr' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: '', KIND: 'herdr' })).toEqual(['--latest=false']);
  });

  test('a prerelease herdr patch stays a prerelease', () => {
    expect(flags({ PRERELEASE: 'true', KIND: 'herdr' })).toEqual(['--prerelease', '--latest=false']);
  });

  test('a pocket patch is not Latest, and a prerelease one stays a prerelease', () => {
    expect(flags({ PRERELEASE: 'false', KIND: 'pocket' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: '', KIND: 'pocket' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: 'true', KIND: 'pocket' })).toEqual(['--prerelease', '--latest=false']);
  });

  test('an am patch is not Latest, and a prerelease one stays a prerelease', () => {
    expect(flags({ PRERELEASE: 'false', KIND: 'am' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: '', KIND: 'am' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: 'true', KIND: 'am' })).toEqual(['--prerelease', '--latest=false']);
  });

  test('a meter patch is not Latest, and a prerelease one stays a prerelease', () => {
    expect(flags({ PRERELEASE: 'false', KIND: 'meter' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: '', KIND: 'meter' })).toEqual(['--latest=false']);
    expect(flags({ PRERELEASE: 'true', KIND: 'meter' })).toEqual(['--prerelease', '--latest=false']);
  });
});

describe('the cut reading the posted herdr-lane pointer before it posts its own', () => {
  const lines = workflow('release.yml');
  const start = lines.findIndex(line => line.trim() === 'mkdir -p herdr-lane/posted');
  const end = lines.findIndex((line, i) => i > start && line.trim().startsWith('bun scripts/herdr-lane.ts posted '));
  const block = start > -1 && end > start ? lines.slice(start, end + 1).join('\n') : '';

  // gh exits `status` after printing `stderr`; bun logs its arguments (the downgrade check ran).
  function read(status: number, stderr = '') {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-lane-posted-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nprintf '%s\\n' '${stderr}' >&2\nexit ${status}\n`);
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/bun.log"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'bun'), 0o755);
    const run = bash(`cd "${dir}"\n${block}`, [], { PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'owner/repo' });
    const log = (name: string) => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
    const result = { ...run, gh: log('gh.log'), bun: log('bun.log') };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  const checked = ['scripts/herdr-lane.ts posted herdr-lane/pack.json herdr-lane/posted'];

  test('is found as the step writes it, with no error swallowed', () => {
    expect(block).not.toBe('');
    expect(block).not.toContain('|| true');
    expect(block).not.toContain('2>/dev/null');
  });

  test('a posted pointer downloads: the downgrade check runs on it', () => {
    const run = read(0);
    expect(run.status).toBe(0);
    expect(run.gh).toEqual(['release download herdr-lane --repo owner/repo -p pack.json -p pack.json.sig -D herdr-lane/posted --clobber']);
    expect(run.bun).toEqual(checked);
  });

  test('no pointer posted yet (the first post): the run goes on to post', () => {
    for (const message of ['no assets match the file pattern', 'no assets to download', 'release not found']) {
      const run = read(1, message);
      expect(run.status).toBe(0);
      expect(run.out).toContain('herdr lane: nothing posted on herdr-lane yet');
      expect(run.bun).toEqual(checked);
    }
  });

  test('any other error reading it (a transient GitHub error, auth, the network) stops the run', () => {
    for (const message of ['HTTP 502: Bad Gateway (https://api.github.com/repos/owner/repo/releases/tags/herdr-lane)', 'HTTP 401: Bad credentials', 'error connecting to api.github.com']) {
      const run = read(1, message);
      expect(run.status).toBe(1);
      expect(run.err).toContain(message);
      expect(run.out).toContain('::error::herdr lane: could not read the posted pointer; refusing to post blind');
      expect(run.bun).toEqual([]);
    }
  });
});

describe('the am-lane job reading the posted pointer, then posting its own', () => {
  const lines = workflow('release.yml');
  const start = lines.findIndex(line => line.trim() === 'mkdir -p am-lane/posted');
  const check = lines.findIndex((line, i) => i > start && line.trim().startsWith('bun scripts/am-lane.ts posted '));
  const end = lines.findIndex((line, i) => i > check && line.trim() === '');
  const block = start > -1 && check > start && end > check ? lines.slice(start, end).join('\n') : '';
  const DOWNLOAD = 'release download am-lane --repo owner/repo -p am.json -p am.json.sig -D am-lane/posted --clobber';
  const UPLOADS = ['release upload am-lane am-lane/am.json --clobber --repo owner/repo', 'release upload am-lane am-lane/am.json.sig --clobber --repo owner/repo'];

  // gh's calls in order: each takes the next `plan` entry (its stderr; '' is success) and exits 1
  // on any text; calls past the plan succeed. bun logs its arguments (the downgrade check ran) and
  // exits `posted`; sleep logs its seconds and returns at once.
  function post(plan: string[] = [], posted = 0) {
    const dir = mkdtempSync(join(tmpdir(), 'am-lane-post-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    mkdirSync(join(dir, 'plan'));
    plan.forEach((stderr, i) => writeFileSync(join(dir, 'plan', String(i + 1)), stderr));
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${dir}/gh.log"
n=$(wc -l < "${dir}/gh.log")
if [ -s "${dir}/plan/$((n))" ]; then cat "${dir}/plan/$((n))" >&2; echo >&2; exit 1; fi
exit 0
`);
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/bun.log"\nexit ${posted}\n`);
    writeFileSync(join(bin, 'sleep'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/sleep.log"\n`);
    for (const name of ['gh', 'bun', 'sleep']) chmodSync(join(bin, name), 0o755);
    const run = bash(`cd "${dir}"\nmkdir -p am-lane\n${block}`, [], { PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'owner/repo' });
    const log = (name: string) => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
    const result = { ...run, gh: log('gh.log'), bun: log('bun.log'), sleep: log('sleep.log') };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  const checked = ['scripts/am-lane.ts posted am-lane/am.json am-lane/posted'];
  const HTTP_500 = 'HTTP 500 (https://api.github.com/repos/owner/repo/releases/assets/123456)';

  test('is found as the step writes it, with no error swallowed', () => {
    expect(block).not.toBe('');
    expect(block).toContain('gh_retry am-lane/upload.err release upload am-lane');
    // The one `|| true` guards the asset id's grep, which finds nothing in most errors.
    expect(block.split('\n').filter(line => line.includes('|| true')).map(line => line.trim().split('=')[0])).toEqual(['asset']);
    expect(block).not.toContain('2>/dev/null');
  });

  test('a posted pointer downloads: the downgrade check runs on it, then am.json and its signature go up, one at a time', () => {
    const run = post();
    expect(run.status).toBe(0);
    expect(run.gh).toEqual([DOWNLOAD, ...UPLOADS]);
    expect(run.bun).toEqual(checked);
    expect(run.sleep).toEqual([]);
  });

  test('no pointer posted yet (the first post): the run goes on to post', () => {
    for (const message of ['no assets match the file pattern', 'no assets to download', 'release not found']) {
      const run = post([message]);
      expect(run.status).toBe(0);
      expect(run.out).toContain('am lane: nothing posted on am-lane yet');
      expect(run.bun).toEqual(checked);
      expect(run.gh).toEqual([DOWNLOAD, ...UPLOADS]);
    }
  });

  test('any other error reading it stops the run at once: no retry, no check, no upload', () => {
    for (const message of ['HTTP 401: Bad credentials', 'error connecting to api.github.com', 'HTTP 404: Not Found']) {
      const run = post([message]);
      expect(run.status).toBe(1);
      expect(run.err).toContain(message);
      expect(run.out).toContain('::error::am lane: could not read the posted pointer (the am-lane release of owner/repo); refusing to post blind');
      expect(run.gh).toEqual([DOWNLOAD]);
      expect(run.bun).toEqual([]);
      expect(run.sleep).toEqual([]);
    }
  });

  // #768, the read path: run 42563550141's HTTP 500 on the download of the posted am.json.
  test('a server error reading it is tried again, three times in all; one that passes lets the post go on', () => {
    for (const plan of [[HTTP_500], ['HTTP 502: Bad Gateway', HTTP_500]]) {
      const run = post(plan);
      expect(run.status).toBe(0);
      expect(run.gh).toEqual([...plan.map(() => DOWNLOAD), DOWNLOAD, ...UPLOADS]);
      expect(run.sleep).toEqual(['10', '20'].slice(0, plan.length));
      expect(run.bun).toEqual(checked);
    }
  });

  test('a server error on every read leaves the pointer untouched and refuses to post blind, naming the asset and the release', () => {
    const run = post([HTTP_500, HTTP_500, HTTP_500]);
    expect(run.status).toBe(1);
    expect(run.gh).toEqual([DOWNLOAD, DOWNLOAD, DOWNLOAD]);
    expect(run.sleep).toEqual(['10', '20']);
    expect(run.bun).toEqual([]);
    expect(run.err).toContain(HTTP_500);
    expect(run.out).toContain('::error::am lane: could not read the posted pointer (the am-lane release of owner/repo, asset 123456); refusing to post blind. Nothing was changed: re-run the job');
  });

  test('a refusal from the downgrade check uploads nothing', () => {
    const run = post([], 1);
    expect(run.status).toBe(1);
    expect(run.gh).toEqual([DOWNLOAD]);
  });

  // #768, the upload path: run 42539380273's HTTP 500 on the am.json asset.
  test('a server error on an upload is tried again, each file on its own count', () => {
    const run = post(['', HTTP_500, '', 'HTTP 503: Service Unavailable', HTTP_500]);
    expect(run.status).toBe(0);
    expect(run.gh).toEqual([DOWNLOAD, UPLOADS[0], UPLOADS[0], UPLOADS[1], UPLOADS[1], UPLOADS[1]]);
    expect(run.sleep).toEqual(['10', '10', '20']);
  });

  test('an upload that fails three times, or with any other error, stops the job and says the pointer may be half-written', () => {
    const json = post(['', HTTP_500, HTTP_500, HTTP_500]);
    expect(json.status).toBe(1);
    expect(json.gh).toEqual([DOWNLOAD, UPLOADS[0], UPLOADS[0], UPLOADS[0]]);
    expect(json.out).toContain('::error::am lane: could not upload am.json to the am-lane release of owner/repo; the posted pointer may be half-written');
    const sig = post(['', '', 'HTTP 422: Validation Failed']);
    expect(sig.status).toBe(1);
    expect(sig.gh).toEqual([DOWNLOAD, ...UPLOADS]);
    expect(sig.sleep).toEqual([]);
    expect(sig.err).toContain('HTTP 422: Validation Failed');
    expect(sig.out).toContain('::error::am lane: could not upload am.json.sig to the am-lane release of owner/repo');
  });
});

describe('every release carries am (RFC 0012)', () => {
  const lines = workflow('release.yml');
  const at = (name: string) => lines.findIndex(line => line.trim() === `- name: ${name}`);
  const ifOf = (name: string) => lines[at(name) + 1]?.trim() ?? '';

  test('am\'s gates and key check run on every release kind, before the tag', () => {
    for (const name of ['The am part\'s gates', 'The am lane\'s signing key']) {
      expect(at(name)).toBeGreaterThan(-1);
      expect(at(name)).toBeLessThan(at('Version, commit and tag'));
    }
    expect(ifOf('The am part\'s gates')).toBe("if: steps.new.outputs.release == 'true'");
    expect(lines[at('The am lane\'s signing key') + 1].trim()).toBe('id: amkey');
    expect(lines[at('The am lane\'s signing key') + 2].trim()).toBe("if: steps.new.outputs.release == 'true'");
  });

  test('am is packed on every kind, before the plugins\' PLUGINS.SHA256SUMS and the publish', () => {
    expect(ifOf('Pack am')).toBe("if: steps.cut.outputs.version != ''");
    expect(at('Pack am')).toBeGreaterThan(at('Version, commit and tag'));
    expect(at('Pack am')).toBeLessThan(at('Pack the plugins'));
    expect(at('Pack am')).toBeLessThan(at('Publish the release'));
  });

  test('am-lane is posted in a job of its own, after the cut, only when check-key said sign=yes', () => {
    // A refusal there (it fails closed) must not skip the plugin lane or any job that needs the cut.
    const jobAt = (name: string) => lines.findIndex(line => line === `  ${name}:`);
    const job = jobAt('am-lane');
    const cutEnds = lines.findIndex((line, i) => i > jobAt('cut') && /^  [a-z-]+:$/.test(line));
    expect(job).toBeGreaterThan(-1);
    expect(at('Sign and post the am lane')).toBeGreaterThan(job);
    expect(at('Sign and post the am lane')).toBeGreaterThan(cutEnds);
    const header = lines.slice(job, at('Sign and post the am lane')).map(line => line.trim());
    expect(header).toContain('needs: cut');
    expect(header).toContain("if: needs.cut.outputs.version != '' && needs.cut.outputs.am_sign == 'yes'");
    expect(lines.slice(jobAt('cut'), cutEnds).map(line => line.trim())).toContain('am_sign: ${{ steps.amkey.outputs.sign }}');
    // No job waits on it: nothing else stops when it does.
    expect(lines.filter(line => /needs: .*am-lane/.test(line))).toEqual([]);
    // It signs the tarball the release published, checked against its .sha256 first.
    const step = lines.slice(at('Sign and post the am lane')).join('\n');
    expect(step.indexOf('sha256sum -c "automagik-am-${VERSION}.tgz.sha256"')).toBeGreaterThan(-1);
    expect(step.indexOf('sha256sum -c')).toBeLessThan(step.indexOf('bun scripts/am-lane.ts manifest'));
  });

  test('an am patch packs no plugins, posts no plugin lane, builds no app and lists nothing', () => {
    const text = lines.join('\n');
    for (const name of ['Pack the add-ons the lane carries', 'Pack the plugins', 'Sign and post the plugin lane']) expect(ifOf(name)).toContain("steps.lane.outputs.kind != 'am'");
    expect(text).toContain("needs.cut.outputs.lane != 'am'");
    expect(text).toContain("if: env.LANE != 'herdr' && env.LANE != 'pocket' && env.LANE != 'am'");
    // Wherever a herdr patch is told apart, an am patch is too.
    const herdrOnly = lines.filter(line => /kind != 'herdr'|lane != 'herdr'|LANE != 'herdr'/.test(line));
    for (const line of herdrOnly) expect(line).toMatch(/!= 'am'/);
  });

  test('the pack step, run on a tag: am/ without its tests, VERSION the release\'s, and its sha256', () => {
    const start = lines.findIndex((line, i) => i > at('Pack am') && line.trim() === 'mkdir -p release');
    const end = lines.findIndex((line, i) => i > start && line.trim() === 'cat "release/${tgz}.sha256"');
    const block = lines.slice(start, end + 1).join('\n');
    expect(start).toBeGreaterThan(at('Pack am'));
    const dir = mkdtempSync(join(tmpdir(), 'am-pack-'));
    try {
      const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
      git('init', '-q');
      mkdirSync(join(dir, 'am', 'test'), { recursive: true });
      mkdirSync(join(dir, 'am', 'bin'));
      writeFileSync(join(dir, 'am', 'VERSION'), '3.70.1\n');
      writeFileSync(join(dir, 'am', 'bin', 'am'), '#!/bin/sh\n');
      writeFileSync(join(dir, 'am', 'test', 'am.test.mjs'), '');
      git('add', '.');
      git('commit', '-qm', 'am');
      git('tag', 'v3.70.1');
      const run = bash(`cd "${dir}"\n${block}`, [], { VERSION: '3.70.1' });
      expect(run.status).toBe(0);
      const names = spawnSync('tar', ['-tzf', join(dir, 'release', 'automagik-am-3.70.1.tgz')], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
      expect(names).toEqual(['VERSION', 'bin/', 'bin/am']);
      expect(existsSync(join(dir, 'release', 'automagik-am-3.70.1.tgz.sha256'))).toBe(true);
      // A tag whose am/VERSION is not the release's stops it.
      git('tag', 'v3.70.2');
      const wrong = bash(`cd "${dir}"\nrm -rf release\n${block}`, [], { VERSION: '3.70.2' });
      expect(wrong.status).toBe(1);
      expect(wrong.out).toContain("::error::am's VERSION in automagik-am-3.70.2.tgz is not 3.70.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the meter lane posting its signed pointer', () => {
  const lines = workflow('release.yml');
  const start = lines.findIndex(line => line.trim() === 'mkdir -p meter-lane/posted');
  const end = lines.findIndex((line, i) => i > start && line.trim().startsWith('bun scripts/meter-lane.ts posted '));
  const block = start > -1 && end > start ? lines.slice(start, end + 1).join('\n') : '';

  function read(status: number, stderr = '') {
    const dir = mkdtempSync(join(tmpdir(), 'meter-lane-posted-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nprintf '%s\\n' '${stderr}' >&2\nexit ${status}\n`);
    writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/bun.log"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'bun'), 0o755);
    const run = bash(`cd "${dir}"\n${block}`, [], { PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'owner/repo' });
    const log = (name: string) => { try { return readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; } };
    const result = { ...run, gh: log('gh.log'), bun: log('bun.log') };
    rmSync(dir, { recursive: true, force: true });
    return result;
  }
  const checked = ['scripts/meter-lane.ts posted meter-lane/meter.json meter-lane/posted'];

  test('is found as the step writes it, with no error swallowed', () => {
    expect(block).not.toBe('');
    expect(block).not.toContain('|| true');
    expect(block).not.toContain('2>/dev/null');
  });

  test('a posted pointer downloads: the downgrade check runs on it', () => {
    const run = read(0);
    expect(run.status).toBe(0);
    expect(run.gh).toEqual(['release download meter-lane --repo owner/repo -p meter.json -p meter.json.sig -D meter-lane/posted --clobber']);
    expect(run.bun).toEqual(checked);
  }, 30_000);

  test('no pointer posted yet (the first post): the run goes on to post', () => {
    for (const message of ['no assets match the file pattern', 'no assets to download', 'release not found']) {
      const run = read(1, message);
      expect(run.status).toBe(0);
      expect(run.out).toContain('meter lane: nothing posted on meter-lane yet');
      expect(run.bun).toEqual(checked);
    }
  }, 30_000);

  test('any other error reading it stops the run', () => {
    for (const message of ['HTTP 502: Bad Gateway', 'HTTP 401: Bad credentials', 'error connecting to api.github.com']) {
      const run = read(1, message);
      expect(run.status).toBe(1);
      expect(run.err).toContain(message);
      expect(run.out).toContain('::error::meter lane: could not read the posted pointer; refusing to post blind');
      expect(run.bun).toEqual([]);
    }
  }, 30_000);
});

describe('the meter lane (RFC 0017 delivery 4)', () => {
  const lines = workflow('release.yml');
  const text = lines.join('\n');
  const at = (name: string) => lines.findIndex(line => line.trim() === `- name: ${name}`);
  const jobAt = (name: string) => lines.findIndex(line => line === `  ${name}:`);
  const jobEnds = (name: string) => { const i = lines.findIndex((line, n) => n > jobAt(name) && /^  [a-z-]+:$/.test(line)); return i < 0 ? lines.length : i; };
  const job = (name: string) => lines.slice(jobAt(name), jobEnds(name));
  const ROOT = join(import.meta.dir, '..');
  const ARTIFACTS: Record<string, string> = JSON.parse(readFileSync(join(ROOT, 'meter', 'usagemeter', 'part.json'), 'utf8')).artifact;

  test('the build matrix builds exactly the four assets part.json names, Intel Mac included, on CI runners', () => {
    const built = job('meter').map(line => /asset: (usagemeter-[a-z0-9_-]+)/.exec(line)?.[1]).filter(Boolean).sort();
    expect(built).toEqual(Object.values(ARTIFACTS).sort());
    expect(built).toContain('usagemeter-darwin-x86_64');
    const header = job('meter').map(line => line.trim());
    expect(header).toContain('needs: cut');
    // Never without the key: check-key said sign=yes, which it says only for a listed key and its secret.
    expect(header).toContain("if: needs.cut.outputs.version != '' && needs.cut.outputs.meter == 'yes' && needs.cut.outputs.meter_sign == 'yes'");
    expect(header).toContain('ref: v${{ needs.cut.outputs.version }}');
    expect(header).toContain('run: cargo build --release --locked --target "${TARGET}"');
    // Linux builds are checked to be static, and a runnable one to say the tag's version.
    const check = job('meter').join('\n');
    expect(check).toContain("grep -Eq 'statically linked|static-pie linked'");
    expect(check).toContain('[[ "${said}" == "usagemeter ${VERSION}" ]]');
  });

  test('the meter\'s gates and key check run before the tag, only when the release builds the meter', () => {
    for (const name of ['The meter\'s gates', 'The meter lane\'s signing key']) {
      expect(at(name)).toBeGreaterThan(-1);
      expect(at(name)).toBeLessThan(at('Version, commit and tag'));
      expect(at(name)).toBeGreaterThan(at('Which lane'));
    }
    expect(lines[at('The meter\'s gates') + 1].trim()).toBe("if: steps.new.outputs.release == 'true' && steps.lane.outputs.meter == 'yes'");
    expect(lines[at('The meter lane\'s signing key') + 1].trim()).toBe('id: meterkey');
    expect(lines[at('The meter lane\'s signing key') + 2].trim()).toBe("if: steps.new.outputs.release == 'true' && steps.lane.outputs.meter == 'yes'");
    const key = lines.slice(at('The meter lane\'s signing key'), at('The meter lane\'s signing key') + 6).join('\n');
    expect(key).toContain("METER_LANE_KEY: ${{ vars.METER_LANE_SIGNER == 'METER_LANE_KEY_NEXT' && secrets.METER_LANE_KEY_NEXT || secrets.METER_LANE_KEY }}");
    expect(key).toContain('run: bun scripts/meter-lane.ts check-key');
    const cut = job('cut').map(line => line.trim());
    expect(cut).toContain('meter: ${{ steps.lane.outputs.meter }}');
    expect(cut).toContain('meter_sign: ${{ steps.meterkey.outputs.sign }}');
  });

  test('the meter is signed with its own key alone, in two places only; the posting job holds no key', () => {
    const attach = job('meter-attach').join('\n');
    expect(attach).toContain('METER_LANE_KEY:');
    for (const other of ['PLUGIN_LANE_KEY', 'HERDR_PACK_KEY', 'AM_LANE_KEY']) expect(attach).not.toContain(other);
    expect(job('meter-lane').join('\n')).not.toMatch(/LANE_KEY|PACK_KEY/);
    // The meter's key reaches no other step: only the key check and the attach step name it.
    const named = lines.map((line, i) => [line, i] as const).filter(([line]) => /secrets\.METER_LANE_KEY/.test(line)).map(([, i]) => i);
    expect(named.length).toBe(2);
    expect(named[0]).toBeGreaterThan(at('The meter lane\'s signing key'));
    expect(named[0]).toBeLessThan(at('The meter lane\'s signing key') + 5);
    expect(named[1]).toBeGreaterThan(at('Attach the binaries, usagemeter.SHA256SUMS and the signed pointer'));
    expect(named[1]).toBeLessThan(jobEnds('meter-attach'));
    // The attach job is gated on the key too, and signs before anything goes up.
    expect(job('meter-attach').map(line => line.trim())).toContain("if: needs.cut.outputs.version != '' && needs.cut.outputs.meter == 'yes' && needs.cut.outputs.meter_sign == 'yes'");
    expect(attach.indexOf('bun scripts/meter-lane.ts verify')).toBeLessThan(attach.indexOf('gh release upload'));
  });

  // The Reviewer's L2: the prerelease list is read (never guessed) and passed to meter-since.
  test('meter-since is told which releases are prereleases, and a failure to list them stops the run', () => {
    const first = lines.findIndex(line => line.trim().startsWith('prerelease_tags=$(gh release list'));
    const call = lines.findIndex(line => line.trim().startsWith('meter_since=$(bun scripts/lane.ts meter-since'));
    expect(first).toBeGreaterThan(-1);
    expect(call).toBe(first + 2);
    expect(lines[first]).toContain('select(.isPrerelease)');
    const block = lines.slice(first, call + 1).join('\n');
    expect(block).not.toContain('|| true');
    const run = (gh: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'meter-since-'));
      mkdirSync(join(dir, 'bin'));
      writeFileSync(join(dir, 'bin', 'gh'), `#!/usr/bin/env bash\n${gh}\n`);
      writeFileSync(join(dir, 'bin', 'bun'), `#!/usr/bin/env bash\nprintf '[%s]' "$@"\n`);
      chmodSync(join(dir, 'bin', 'gh'), 0o755);
      chmodSync(join(dir, 'bin', 'bun'), 0o755);
      const result = bash(`${block}\necho "\${meter_since}"`, [], { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, GITHUB_REPOSITORY: 'owner/repo', last: 'v3.110.2', meter_version: '' });
      rmSync(dir, { recursive: true, force: true });
      return result;
    };
    expect(run("printf 'v3.110.2\\nv3.110.1\\n'").out.trim()).toBe('[scripts/lane.ts][meter-since][v3.110.2][][v3.110.2][v3.110.1]');
    // None a prerelease: one empty argument, which matches no tag.
    expect(run('true').out.trim()).toBe('[scripts/lane.ts][meter-since][v3.110.2][][]');
    // gh fails: the run stops, it never guesses a base.
    const failed = run('echo "HTTP 502" >&2; exit 1');
    expect(failed.status).not.toBe(0);
    expect(failed.out).toBe('');
  });

  test('meter-lane is posted in a job of its own after the binaries, never on a prerelease, and nothing waits on it', () => {
    const header = job('meter-lane').map(line => line.trim());
    expect(header).toContain('needs: [cut, meter-attach]');
    expect(header).toContain("if: needs.cut.outputs.version != '' && needs.cut.outputs.meter == 'yes' && needs.cut.outputs.meter_sign == 'yes' && inputs.prerelease != true");
    expect(header).toContain('group: meter-lane');
    expect(header).toContain('METER_LANE_REPLACE_UNVERIFIED: ${{ inputs.replace_unverified_meter_pointer }}');
    expect(lines.filter(line => /needs: .*meter-lane/.test(line))).toEqual([]);
    // It posts the pointer the release holds, checked against its key list and its binaries first.
    const step = job('meter-lane').join('\n');
    expect(step.indexOf('sha256sum -c usagemeter.SHA256SUMS')).toBeGreaterThan(-1);
    for (const check of ['sha256sum -c', 'bun scripts/meter-lane.ts verify release/meter.json', 'bun scripts/meter-lane.ts matches release/meter.json release', 'bun scripts/meter-lane.ts posted']) {
      expect(step.indexOf(check)).toBeGreaterThan(-1);
      expect(step.indexOf(check)).toBeLessThan(step.indexOf('gh release upload meter-lane'));
    }
    // Both entry points take the dispatch input.
    expect(text.match(/^      replace_unverified_meter_pointer:$/gm)?.length).toBe(2);
  });

  test('a meter patch packs no plugins, posts no plugin lane, builds no app and lists nothing', () => {
    const ifOf = (name: string) => lines[at(name) + 1]?.trim() ?? '';
    for (const name of ['Pack the add-ons the lane carries', 'Pack the plugins', 'Sign and post the plugin lane']) expect(ifOf(name)).toContain("steps.lane.outputs.kind != 'meter'");
    expect(text).toContain("needs.cut.outputs.lane != 'meter'");
    expect(text).toContain("if: env.LANE != 'herdr' && env.LANE != 'pocket' && env.LANE != 'am' && env.LANE != 'meter'");
    // Wherever a herdr patch is told apart, a meter patch is too.
    const herdrOnly = lines.filter(line => /kind != 'herdr'|lane != 'herdr'|LANE != 'herdr'/.test(line));
    for (const line of herdrOnly) expect(line).toMatch(/!= 'meter'/);
    // And it is a patch: 3.N.P on the newest 3.N.
    expect(text).toContain('|| "${KIND}" == "meter" ]]; then version=$(bun scripts/lane.ts next-patch)');
  });

  // The dry run: the attach step as written, with the four binaries the matrix uploads, part.json and
  // meter-keys.json from the tag, and a fake gh and bun. The first meter release carries all four,
  // usagemeter.SHA256SUMS and the signed pointer; with no key listed it attaches nothing.
  describe('a dry run of the attach step', () => {
    const step = at('Attach the binaries, usagemeter.SHA256SUMS and the signed pointer');
    const start = lines.findIndex((line, i) => i > step && line.trim() === 'set -euo pipefail');
    const end = lines.findIndex((line, i) => i > start && line.trim().startsWith('gh release upload "v${VERSION}"'));
    const block = step > -1 && start > step && end > start ? lines.slice(start, end + 1).join('\n') : '';
    const LISTED = '{"keys":[{"keyId":"meter-test","publicKey":"x"}]}';

    function attach(names: string[], keys = LISTED) {
      const dir = mkdtempSync(join(tmpdir(), 'meter-attach-'));
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      mkdirSync(join(dir, 'meter', 'usagemeter'), { recursive: true });
      mkdirSync(join(dir, 'meter-assets'));
      writeFileSync(join(dir, 'meter', 'usagemeter', 'part.json'), readFileSync(join(ROOT, 'meter', 'usagemeter', 'part.json')));
      writeFileSync(join(dir, 'meter', 'usagemeter', 'meter-keys.json'), keys);
      for (const name of names) writeFileSync(join(dir, 'meter-assets', name), `${name} binary`);
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\n`);
      writeFileSync(join(bin, 'bun'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/bun.log"\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      chmodSync(join(bin, 'bun'), 0o755);
      const run = bash(`cd "${dir}"\n${block}`, [], { PATH: `${bin}:${process.env.PATH ?? ''}`, VERSION: '3.109.1', SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'owner/repo' });
      const read = (name: string) => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };
      const result = { ...run, gh: read('gh.log').trim().split('\n').filter(Boolean), bun: read('bun.log').trim().split('\n').filter(Boolean), sums: read('meter-assets/usagemeter.SHA256SUMS') };
      rmSync(dir, { recursive: true, force: true });
      return result;
    }
    const four = Object.values(ARTIFACTS);

    test('is found as the step writes it', () => {
      expect(block).not.toBe('');
      expect(lines[step + 1]?.trim()).toBe('env:');
    });

    test('the first meter release carries the four binaries, darwin-x86_64 included, their sums and the signed pointer', () => {
      const run = attach(four);
      expect(run.status).toBe(0);
      // One upload, --clobber: a re-run after a partial upload completes it (the Reviewer's L3).
      expect(run.gh).toEqual([
        `release upload v3.109.1 ${four.map(name => `meter-assets/${name}`).join(' ')} meter-assets/usagemeter.SHA256SUMS meter-assets/meter.json.sig meter-assets/meter.json --clobber --repo owner/repo`,
      ]);
      expect(run.gh[0]).toContain('meter-assets/usagemeter-darwin-x86_64');
      // Signed and verified before the upload.
      expect(run.bun.map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(['scripts/meter-lane.ts manifest', 'scripts/meter-lane.ts sign', 'scripts/meter-lane.ts verify']);
      const listed = run.sums.trim().split('\n').map(line => line.split(/\s+/)[1]).sort();
      expect(listed).toEqual([...four].sort());
      for (const line of run.sums.trim().split('\n')) expect(line).toMatch(/^[0-9a-f]{64}  usagemeter-[a-z0-9_-]+$/);
    });

    test('no key listed in the tag\'s meter-keys.json: nothing signed, nothing attached', () => {
      for (const keys of ['{"keys":[]}', '{}']) {
        const run = attach(four, keys);
        expect(run.status).toBe(1);
        expect(run.out).toContain('::error::meter/usagemeter/meter-keys.json lists no key: the meter lane is held, nothing is attached');
        expect(run.gh).toEqual([]);
        expect(run.bun).toEqual([]);
      }
    });

    test('a binary missing, or one more than part.json names, attaches nothing', () => {
      for (const names of [four.filter(name => name !== 'usagemeter-darwin-x86_64'), [...four, 'usagemeter-windows-x86_64'], []]) {
        const run = attach(names);
        expect(run.status).toBe(1);
        expect(run.out).toContain('::error::the meter jobs built');
        expect(run.gh).toEqual([]);
      }
    });
  });
});

describe("the cut's 'Anything new since the last release' step", () => {
  const lines = workflow('release.yml');
  const step = lines.findIndex(line => line.trim() === '- name: Anything new since the last release');
  const runLine = lines.findIndex((line, i) => i > step && line.trim() === 'run: |');
  const indent = runLine > -1 ? (/^ */.exec(lines[runLine])?.[0].length ?? 0) + 2 : 0;
  const body: string[] = [];
  for (let i = runLine + 1; step > -1 && runLine > -1 && i < lines.length; i++) {
    if (lines[i].trim() !== '' && (/^ */.exec(lines[i])?.[0].length ?? 0) < indent) break;
    body.push(lines[i].slice(indent));
  }
  const script = body.join('\n');

  // scripts/lane.ts ships <last>, answered from the repository's real diff: yes when a changed path
  // reaches an install; no for the never-shipped ones (docs, scripts, .github, tests, markdown) and
  // a release's own version-only bump of the root package.json. Each call is logged for the tests.
  const FAKE = `#!/usr/bin/env bash
[[ "$1" == scripts/lane.ts && "$2" == ships ]] || { echo "unexpected lane.ts call: $*" >&2; exit 2; }
printf '%s\\n' "$*" >> .lane-calls.log
ships=no
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    docs/*|scripts/*|.github/*|*/test/*|*.md) continue ;;
    package.json)
      if diff -q <(git show "$3:package.json" | grep -v '"version"') <(grep -v '"version"' package.json) > /dev/null; then continue; fi ;;
  esac
  ships=yes
done <<< "$(git diff --name-only "$3"..HEAD)"
printf '%s\\n' "$ships"
`;

  // A repository whose base is tagged v3.0.0; each commit writes its files and lands with its
  // subject. The step runs as written against it with the fake bun on PATH, its `release=true` going
  // to a temp GITHUB_OUTPUT.
  function cut(commits: { subject: string; files?: Record<string, string> }[], options: { tag?: string | null; bun?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'release-new-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    const git = (...args: string[]) => {
      const done = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      if (done.status !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr}`);
      return done.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'dev');
      writeFileSync(join(dir, 'package.json'), '{"version":"3.0.0"}\n');
      writeFileSync(join(dir, 'README.md'), '# base\n');
      git('add', '-A');
      git('commit', '-q', '-m', 'chore: the base');
      if (options.tag !== null) git('tag', options.tag ?? 'v3.0.0');
      for (const { subject, files = {} } of commits) {
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(dir, path)), { recursive: true });
          writeFileSync(join(dir, path), text);
        }
        git('add', '-A');
        git('commit', '-q', '-m', subject);
      }
      writeFileSync(join(bin, 'bun'), options.bun ?? FAKE);
      chmodSync(join(bin, 'bun'), 0o755);
      const done = spawnSync('bash', ['-c', script], { cwd: dir, encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GITHUB_OUTPUT: output } });
      let calls: string[] = [];
      try { calls = readFileSync(join(dir, '.lane-calls.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { /* never asked */ }
      return { status: done.status, out: done.stdout, err: done.stderr, output: readFileSync(output, 'utf8'), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const pocket = 'apps/pocket/android/app/src/main/java/ai/namastex/automagik/PocketViewModel.kt';
  const pocketTest = 'apps/pocket/android/app/src/test/java/ai/namastex/automagik/PocketViewModelChatTest.kt';
  const shipped = 'apps/bots-dsh/src/host/agents.js';

  test('is found as the step writes it, with the ships decision before the subjects', () => {
    expect(script).not.toBe('');
    expect(script).toContain('bun scripts/lane.ts ships "${last}"');
    expect(script).toContain('dev has nothing since ${last}: no release');
    expect(script).toContain('nothing since ${last} reaches an install: no release');
    // The path decision comes first: it alone may release.
    expect(script.indexOf('ships=$(bun scripts/lane.ts ships')).toBeLessThan(script.indexOf('git log --no-merges'));
  });

  test('the #759 shape: a test(pocket) or a docs(...) subject whose diff ships Pocket source releases', () => {
    for (const subject of ['test(pocket): unit-test the view-model chat wiring (#754) (#759)', 'docs(pocket): describe the view-model chat wiring']) {
      const run = cut([{ subject, files: { [pocket]: 'package ai.namastex.automagik\n' } }]);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(['scripts/lane.ts ships v3.0.0']);
      expect(run.output).toBe('release=true\n');
      expect(run.out).toBe('');
    }
  });

  test('a docs-only or a test-only diff under a never-shipped path is skipped', () => {
    const cases = [
      { subject: 'docs(pocket): explain the wiring', files: { 'docs/pocket/wiring.md': '# wiring\n' } },
      { subject: 'test(pocket): cover the wiring', files: { [pocketTest]: 'class PocketViewModelChatTest\n' } },
    ];
    for (const commit of cases) {
      const run = cut([commit]);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(['scripts/lane.ts ships v3.0.0']);
      expect(run.output).toBe('');
      expect(run.out).toContain('dev has nothing since v3.0.0: no release');
    }
  });

  test('a chore(release) version-only commit is skipped', () => {
    const run = cut([{ subject: 'chore(release): 3.0.1', files: { 'package.json': '{"version":"3.0.1"}\n' } }]);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.0.0']);
    expect(run.output).toBe('');
    expect(run.out).toContain('dev has nothing since v3.0.0: no release');
  });

  test('a non-inert subject whose change reaches no install is still skipped by the path decision', () => {
    const cases = [
      { subject: 'feat(tooling): teach the release test to read subjects', files: { 'scripts/release-workflows.test.ts': '// test\n' } },
      { subject: 'chore(ci): let the matrix name its runner', files: { '.github/workflows/ci.yml': 'name: CI\n' } },
    ];
    for (const commit of cases) {
      const run = cut([commit]);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual(['scripts/lane.ts ships v3.0.0']);
      expect(run.output).toBe('');
      expect(run.out).toContain('nothing since v3.0.0 reaches an install: no release');
      expect(run.out).not.toContain('dev has nothing');
    }
  });

  test('a normal subject with a shipped path releases', () => {
    const run = cut([{ subject: 'fix(bots): stop dropping the first message', files: { [shipped]: 'export {};\n' } }]);
    expect(run.status).toBe(0);
    expect(run.calls).toEqual(['scripts/lane.ts ships v3.0.0']);
    expect(run.output).toBe('release=true\n');
  });

  test('the first release, with no tag to measure from, releases without asking ships', () => {
    const run = cut([{ subject: 'feat(bots): the first cut', files: { [shipped]: 'export {};\n' } }], { tag: null });
    expect(run.status).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.output).toBe('release=true\n');
  });

  test('a failed ships call stops the run instead of reading as nothing to release', () => {
    const run = cut([{ subject: 'test(pocket): cover the wiring', files: { [pocketTest]: 'class T\n' } }], { bun: '#!/usr/bin/env bash\nexit 3\n' });
    expect(run.status).toBe(3);
    expect(run.output).toBe('');
    expect(run.out).toBe('');
  });

  test('an answer that is neither yes nor no stops the run', () => {
    const run = cut([{ subject: 'fix(bots): stop dropping the first message', files: { [shipped]: 'export {};\n' } }], { bun: '#!/usr/bin/env bash\necho maybe\n' });
    expect(run.status).toBe(1);
    expect(run.output).toBe('');
    expect(run.out).toContain("::error::scripts/lane.ts ships v3.0.0 printed 'maybe', not yes or no");
  });
});

describe("the release's plugin set", () => {
  // The tarballs the cut packs and the names plugins.json carries must be one set: an app packed
  // again but filtered out of pluginNames() would publish an asset nothing verified, and a name
  // with no tarball fails releasePlugins() only after the tag.
  test('the pack loop packs exactly the plugins plugins.json names', () => {
    const text = readFileSync(join(import.meta.dir, '..', '.github', 'workflows', 'release.yml'), 'utf8');
    const match = /for app in ([\w- ]+); do\n\s+\(cd "apps\/\$\{app\}" && npm pack/.exec(text);
    expect(match).not.toBeNull();
    const packed = match![1].trim().split(/\s+/).sort();
    const named = pluginNames().map((name) => `${name.replace('@automagik/', '').replace(/-dsh$/, '')}-dsh`).sort();
    expect(packed).toEqual(named);
    // No release asset names an Unfold plugin (they left with RFC 0020).
    expect(packed.filter((name) => name.startsWith('unfold-'))).toEqual([]);
  });
});
