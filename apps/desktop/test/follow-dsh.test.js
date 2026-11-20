import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PLUGINS, acceptsHarness, pinPatchVersions, pinRange, pinRuntime, rangeFor } from '../scripts/follow-dsh.mjs'

const runtime = { name: 'omni-desktop-runtime', private: true, dependencies: { '@deepseek-ai/dsh': '0.2.1-rc.2', pnpm: '10.34.6' } }

test('the runtime moves to the dsh the carried Omni tests on, and keeps the rest', () => {
  const next = pinRuntime(runtime, '0.2.1-rc.3')
  assert.equal(next.dependencies['@deepseek-ai/dsh'], '0.2.1-rc.3')
  assert.equal(next.dependencies.pnpm, '10.34.6')
  assert.equal(next.name, 'omni-desktop-runtime')
  assert.equal(runtime.dependencies['@deepseek-ai/dsh'], '0.2.1-rc.2', 'the input is not mutated')
})

test('a runtime already on that dsh is left alone', () => {
  assert.equal(pinRuntime(runtime, '0.2.1-rc.2'), null)
})

test('anything but an exact version is refused', () => {
  for (const bad of ['', undefined, 'latest', '^0.2.1', '0.2.1-rc.3; rm -rf /', '>=0.2.1']) {
    assert.throws(() => pinRuntime(runtime, bad), /not a dsh version/)
  }
})

test('a plugin tested on a dsh declares it up to the next minor, its prereleases excluded', () => {
  assert.equal(rangeFor('0.2.1-rc.3'), '>=0.2.1-rc.3 <0.3.0-0')
  assert.equal(rangeFor('0.2.1'), '>=0.2.1 <0.3.0-0')
  assert.equal(rangeFor('0.3.0-alpha.1'), '>=0.3.0-alpha.1 <0.4.0-0')
  assert.throws(() => rangeFor('^0.2.1'), /not a dsh version/)
  assert.deepEqual(pinRange({ name: 'p', engines: { dsh: '>=0.2.1-rc.3 <0.3.0-0' } }, '0.2.2-rc.1'), { name: 'p', engines: { dsh: '>=0.2.2-rc.1 <0.3.0-0' } })
  assert.equal(pinRange({ engines: { dsh: '>=0.2.1-rc.3 <0.3.0-0' } }, '0.2.1-rc.3'), null)
})

test('the plugins it moves are the ones that declare the range, and their range is the one it writes', () => {
  for (const name of PLUGINS) {
    const manifest = JSON.parse(readFileSync(new URL(`../../${name}/package.json`, import.meta.url), 'utf8'))
    const tested = JSON.parse(readFileSync(new URL(`../../${name}/dev/harness/package.json`, import.meta.url), 'utf8')).dependencies['@deepseek-ai/dsh']
    assert.equal(manifest.engines?.dsh, rangeFor(tested), name)
  }
})

test('follow-omni follows only an Omni release tested on the dsh the desktop runs', () => {
  const text = readFileSync(new URL('../../../.github/workflows/follow-omni.yml', import.meta.url), 'utf8')
  assert.match(text, /apps\/omni-channels-dsh\/dev\/harness\/package\.json/)
  assert.match(text, /require\('\.\/apps\/desktop\/runtime\/package\.json'\)/)
  assert.ok(text.indexOf('not following it until the Bot team moves') < text.indexOf('git commit -qa'), 'a mismatch stops before the commit')
  // The welcome installs the same Omni release in a plain DSH: both pins move in one commit.
  assert.ok(text.indexOf('apps/welcome-dsh/package.json') < text.indexOf('git commit -qa'))
  assert.match(text, /pkg\.automagik\.omni = \{ \.\.\.pkg\.automagik\.omni, version, commit, tree \}/)
})

test('follow-omni carries an Omni only after it booted, on the dev commit that booted', () => {
  const text = readFileSync(new URL('../../../.github/workflows/follow-omni.yml', import.meta.url), 'utf8')
  const carry = text.slice(text.indexOf('\n  carry:\n'), text.indexOf('\n  release:\n'))
  // The bump is pushed with GITHUB_TOKEN, so CI never boots it: the gate is here or nowhere.
  assert.match(text, /\n {2}boot:\n[\s\S]*?uses: \.\/\.github\/workflows\/boot-check\.yml[\s\S]*?ref: \$\{\{ needs\.follow\.outputs\.dev \}\}/)
  assert.match(carry, /needs: \[follow, boot\]/)
  assert.match(carry, /ref: \$\{\{ needs\.follow\.outputs\.dev \}\}/)
  // Only a fast-forward from the commit that booted: a dev that moved is refused, not overwritten.
  assert.doesNotMatch(carry, /--force|\+HEAD/)
  assert.match(carry, /dev moved from/)
  assert.match(text, /\n {2}release:\n {4}name: Release\n {4}needs: carry\n/)
})

test('follow-omni runs on Omni\'s dispatch and the outside daily clock, taking the payload only as a logged hint', () => {
  const text = readFileSync(new URL('../../../.github/workflows/follow-omni.yml', import.meta.url), 'utf8')
  assert.match(text, /\n {2}repository_dispatch:\n(?: {4}#[^\n]*\n)* {4}types: \[omni-release, daily-carry\]\n/)
  // The schedule stays as the fallback, and every run queues behind a running follow.
  assert.match(text, /\n {2}schedule:\n[\s\S]*?- cron: '/)
  assert.match(text, /\nconcurrency:\n {2}group: follow-omni\n {2}cancel-in-progress: false\n/)
  // The payload reaches the job only through env, never a run script or another expression.
  const uses = text.split('\n').filter(line => line.includes('client_payload') && !line.trim().startsWith('#'))
  assert.deepEqual(uses.map(line => line.trim()), [
    'HINT_VERSION: ${{ github.event.client_payload.version }}',
    'HINT_TAG: ${{ github.event.client_payload.tag }}',
    'HINT_SHA: ${{ github.event.client_payload.sha }}',
  ])
  // The hint is printed, only in a shape check, and never chooses what is booted or carried.
  const hints = [...text.matchAll(/\$\{HINT_\w+\}/g)].map(match => match.index)
  assert.equal(hints.length, 3)
  for (const at of hints) assert.match(text.slice(text.lastIndexOf('\n', at), text.indexOf('\n', at)), /\$\(hint "/)
  const output = text.slice(text.indexOf('commit="${WANT_COMMIT:-'), text.indexOf('} >> "$GITHUB_OUTPUT"'))
  assert.doesNotMatch(output, /HINT_|client_payload/)
  assert.doesNotMatch(text, /(?:WANT_\w+|newest|commit)=\S*HINT_/)
  // A release the list lags on is looked up again, a bounded number of times, then warned about;
  // what is followed is still only what the lookup lists (or a dry run's omni_version).
  assert.match(text, /for try in 1 2 3 4 5 6; do\n\s+unlisted \|\| break\n[\s\S]*?sleep 20\n\s+lookup\n\s+done\n/)
  assert.match(text, /if unlisted; then\n\s+echo "::warning ::Omni dispatched \$\{wanted\}/)
  assert.deepEqual([...text.matchAll(/\bnewest=(.*)/g)].map(match => match[1]), ['"${WANT_VERSION}"', '$(sort -V releases.txt | tail -1)'])
  // The newest listed release is followed as it is (#1915): npm's server no longer picks it.
  assert.doesNotMatch(text, /registry\.npmjs\.org|\$\{candidate\}|read -r candidate/)
  assert.match(text, /# follow: start\n[\s\S]*?! above "\$\{newest\}" "\$\{current\}"[\s\S]*?# follow: end\n/)
})

test('the boot gate boots the candidate exactly as carry writes it, both pins', () => {
  const read = name => readFileSync(new URL(`../../../.github/workflows/${name}`, import.meta.url), 'utf8')
  const bump = text => text.match(/\n {10}node -e '\n([\s\S]*?)\n {10}' "\$\{(?:OMNI_)?VERSION\}" "\$\{(?:OMNI_)?COMMIT\}" "\$\{(?:TREE|tree)\}"/)?.[1]
  const carried = bump(read('follow-omni.yml'))
  assert.ok(carried?.includes('apps/welcome-dsh/package.json'), 'carry moves the welcome too')
  assert.equal(bump(read('boot-check.yml')), carried)
})


test('a carried Omni harness admits only newer compatible releases in the same minor series', () => {
  const range = '>=0.2.1-rc.3 <0.3.0-0'
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', '0.2.2-alpha.1', '0.2.2']) {
    assert.equal(acceptsHarness(version, '0.2.1-rc.3', range), true, version)
  }
  // dsh resolves engines with includePrerelease, so the next minor's prereleases must be excluded.
  for (const version of ['0.2.1-rc.2', '0.3.0-alpha.1', '0.3.0-rc.1', '0.3.0', 'latest', undefined]) {
    assert.equal(acceptsHarness(version, '0.2.1-rc.3', range), false, version)
  }
  assert.equal(acceptsHarness('0.2.1-rc.4', '0.2.1-rc.3', '>=0.2.1-rc.3 <0.2.1-rc.4'), false)
  assert.equal(acceptsHarness('0.2.1-rc.4', '0.2.1-rc.3', undefined), false)
  assert.equal(acceptsHarness('0.2.1-rc.4', undefined, range), false)
  assert.equal(acceptsHarness('0.2.2', '0.2.1-rc.3', '>=0.2.1-rc.2 <0.3.0-0'), true)
})

test('patch version tooling preserves exact-byte guards and does not mutate its input', () => {
  const patches = [{ patch: 'route.patch', about: 'keep routing', dsh: '0.2.1-rc.4', files: [
    { package: '@deepseek-ai/dsh-experimental-agent-team', version: '0.2.1-rc.4', file: 'lib/index.js', before: 'before-hash', after: 'after-hash' },
  ] }]
  const original = structuredClone(patches)
  const next = pinPatchVersions(patches, '0.2.1-rc.5')
  assert.equal(next[0].dsh, '0.2.1-rc.5')
  assert.equal(next[0].files[0].version, '0.2.1-rc.5')
  assert.deepEqual({ ...next[0], dsh: original[0].dsh, files: next[0].files.map((file, i) => ({ ...file, version: original[0].files[i].version })) }, original[0])
  assert.deepEqual(patches, original)
  assert.equal(pinPatchVersions(next, '0.2.1-rc.5'), null)
  assert.throws(() => pinPatchVersions(patches, '^0.2.1'), /not a dsh version/)
})

test('all runtime patch version guards track the desktop DSH pin', () => {
  const pinned = JSON.parse(readFileSync(new URL('../runtime/package.json', import.meta.url), 'utf8')).dependencies['@deepseek-ai/dsh']
  const patches = JSON.parse(readFileSync(new URL('../runtime/patches/patches.json', import.meta.url), 'utf8'))
  assert.equal(pinPatchVersions(patches, pinned), null)
})

test('all shipped plugin harnesses track the exact desktop DSH pin', () => {
  assert.deepEqual([...PLUGINS].sort(), ['acp-dsh', 'bots-dsh', 'locale-pt-br-dsh', 'vault-dsh', 'welcome-dsh'])
  const pinned = JSON.parse(readFileSync(new URL('../runtime/package.json', import.meta.url), 'utf8')).dependencies['@deepseek-ai/dsh']
  for (const name of PLUGINS) {
    const tested = JSON.parse(readFileSync(new URL(`../../${name}/dev/harness/package.json`, import.meta.url), 'utf8')).dependencies['@deepseek-ai/dsh']
    assert.equal(tested, pinned, name)
  }
})
