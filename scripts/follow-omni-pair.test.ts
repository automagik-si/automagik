import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = Bun.YAML.parse(readFileSync(
  join(import.meta.dir, '..', '.github', 'workflows', 'follow-omni.yml'), 'utf8',
)) as { jobs: { follow: { steps: { id?: string; run?: string }[] } } };
const run = workflow.jobs.follow.steps.find(step => step.id === 'newest')?.run ?? '';
const lookup = run.match(/^ +lookup\(\) \{[\s\S]*?^ +lookup$/m)?.[0];
const pair = run.match(/^ +# pair: start\n([\s\S]*?)^ +# pair: end$/m)?.[1];
if (!lookup || !pair) throw new Error('The newest Omni release step must contain its lookup and pair block');

const npm = '2.261109.2';
const manifests = {
  '2.261120.2': { version: '2.261120.1', engines: { omni: '>=2.261116.3 <3' } },
  '2.261112.7': { version: '2.261112.7', engines: { omni: '>=2.261112.7' } },
  '2.261112.6': { version: '2.261112.5', engines: { omni: '>=2.261102.41' } },
};
type Manifest = { version: string; engines?: { omni?: string } };

function follow(current: string, tags = JSON.stringify({ latest: npm }), releases: Record<string, Manifest> = manifests) {
  const dir = mkdtempSync(join(tmpdir(), 'follow-omni-pair-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3 $4" == 'api --paginate repos/automagik-si/omni/releases?per_page=100 --jq' ]]
cat versions
`, { mode: 0o755 });
    writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2 $3" == '-fsS --max-time 20' ]]
case "$4" in
  'https://registry.npmjs.org/-/package/@automagik%2fomni/dist-tags')
    echo npm >> requests
    cat npm.json
    ;;
  https://raw.githubusercontent.com/automagik-si/omni/v*/apps/omni-channels-dsh/package.json)
    version=$(cut -d / -f 6 <<< "$4" | cut -c 2-)
    echo "$version" >> requests
    cat "$version.json"
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
    writeFileSync(join(dir, 'versions'), `${Object.keys(releases).reverse().join('\n')}\n`);
    writeFileSync(join(dir, 'npm.json'), tags);
    writeFileSync(join(dir, 'requests'), '');
    for (const [version, manifest] of Object.entries(releases)) {
      writeFileSync(join(dir, `${version}.json`), JSON.stringify(manifest));
    }
    const result = spawnSync('bash', ['-c', `set -euo pipefail\n${lookup}\n${pair}\nprintf 'selected=%s\\n' "$newest"`], {
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

test('holds the shared pin when no newer release pairs with npm', () => {
  expect(follow('2.261112.6')).toEqual({
    out: 'no Omni release above 2.261112.6 has a channels plugin that accepts npm\'s server 2.261109.2: nothing to follow',
    requests: ['npm', '2.261120.2', '2.261112.7'],
  });
});

test('selects the newest compatible release above an older pin', () => {
  expect(follow('2.261108.1')).toEqual({
    out: 'selected=2.261112.6',
    requests: ['npm', '2.261120.2', '2.261112.7', '2.261112.6'],
  });
});

test('follows a newer pair as npm advances', () => {
  expect(follow('2.261112.6', JSON.stringify({ latest: '2.261116.3' }))).toEqual({
    out: 'selected=2.261120.2',
    requests: ['npm', '2.261120.2'],
  });
});

test.each(['unreadable', JSON.stringify({ latest: '2.261109.2-rc.1' })])(
  'warns and follows nothing when the npm response is %s',
  tags => {
    expect(follow('2.261108.1', tags)).toEqual({
      out: "::warning ::Could not read npm's latest Omni server version: nothing to follow",
      requests: ['npm'],
    });
  },
);

test('uses the channels manifest version when engines.omni is absent', () => {
  expect(follow('2.261108.1', undefined, {
    '2.261120.2': { version: '2.261109.3' },
    '2.261112.7': { version: npm },
  })).toEqual({
    out: 'selected=2.261112.7',
    requests: ['npm', '2.261120.2', '2.261112.7'],
  });
});
