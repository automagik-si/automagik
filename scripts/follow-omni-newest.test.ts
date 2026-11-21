import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// follow-omni.yml follows the newest listed Omni release above omni.json's (#1915): npm's server
// no longer picks it, because the welcome builds a release's server from GitHub when npm lacks it.
const workflow = Bun.YAML.parse(readFileSync(
  join(import.meta.dir, '..', '.github', 'workflows', 'follow-omni.yml'), 'utf8',
)) as { jobs: { follow: { steps: { id?: string; run?: string }[] } } };
const run = workflow.jobs.follow.steps.find(step => step.id === 'newest')?.run ?? '';
const lookup = run.match(/^ +lookup\(\) \{[\s\S]*?^ +lookup$/m)?.[0];
const above = run.match(/^ +above\(\) \{.*\}$/m)?.[0];
const follow = run.match(/^ +# follow: start\n([\s\S]*?)^ +# follow: end$/m)?.[1];
if (!lookup || !above || !follow) throw new Error('The newest Omni release step must contain its lookup, above and follow block');

function pick(current: string, releases: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'follow-omni-newest-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3 $4" == 'api --paginate repos/automagik-si/omni/releases?per_page=100 --jq' ]]
echo gh >> requests
cat versions
`, { mode: 0o755 });
    // Anything else on the network is a failure: npm is not asked.
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\necho "curl $*" >> requests\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(dir, 'versions'), releases.length ? `${releases.join('\n')}\n` : '');
    writeFileSync(join(dir, 'requests'), '');
    const script = `set -euo pipefail\n${above}\n${lookup}\n${follow}\nprintf 'selected=%s\\n' "$newest"`;
    const result = spawnSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, OMNI: 'automagik-si/omni', current },
    });
    expect(result.status, result.stderr || result.error?.message).toBe(0);
    return { out: result.stdout.trim(), requests: readFileSync(join(dir, 'requests'), 'utf8').trim().split('\n') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('selects the newest listed release above the pin, whatever npm has', () => {
  expect(pick('2.261112.6', ['2.261112.6', '2.261120.2', '2.261118.16'])).toEqual({ out: 'selected=2.261120.2', requests: ['gh'] });
});

test('holds when the pin is the newest release', () => {
  expect(pick('2.261120.2', ['2.261112.6', '2.261120.2'])).toEqual({
    out: 'Omni 2.261120.2: omni.json is at 2.261120.2, nothing to follow',
    requests: ['gh'],
  });
});

test('never moves down to an older release', () => {
  expect(pick('2.261120.2', ['2.261112.6', '2.261119.2'])).toEqual({
    out: 'Omni 2.261119.2: omni.json is at 2.261120.2, nothing to follow',
    requests: ['gh'],
  });
});

test('follows nothing when no release is listed', () => {
  expect(pick('2.261120.2', [])).toEqual({ out: 'Omni none: omni.json is at 2.261120.2, nothing to follow', requests: ['gh'] });
});
