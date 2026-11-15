import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const workflow = readFileSync(join(root, '.github/workflows/server-image.yml'), 'utf8');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const revision = 'a'.repeat(40);
const owned: string[] = [];
afterEach(() => { for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function block(name: string) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start < 0) throw new Error(`missing step ${name}`);
  return workflow.slice(start).split(/\n      - /)[0];
}
function script(name: string) {
  const step = block(name), body = step.split('        run: |\n')[1];
  if (!body) return step.split('        run: ')[1].trim();
  return body.split('\n').filter((line) => line.startsWith('          ') || !line.trim()).map((line) => line.slice(10)).join('\n');
}
function gate(event: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-event-test-')); owned.push(dir);
  const output = join(dir, 'output'), calls = join(dir, 'calls');
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == api ]]; then printf '%s\\n' "$NEWEST"; exit; fi
if [[ "$*" == *isPrerelease* ]]; then printf '%s\\n' "$PRE"; exit; fi
if [[ "$HAS" == all || "$3" == "$HAS" ]]; then echo plugins.json; else echo other; fi
`); chmodSync(gh, 0o755);
  const result = spawnSync('bash', ['-c', script('Resolve the image content and whether to publish')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, GITHUB_OUTPUT: output,
      EVENT: event, REF: 'refs/heads/dev', REF_NAME: 'dev', RELEASE_TAG: `v${version}`, RELEASE_PRERELEASE: 'false',
      DISPATCH_CONTENT: '', REPOSITORY: 'fixture/repo', REVISION: revision, HAS: 'all', NEWEST: '1.2.3', PRE: 'false', ...extra },
  });
  return { ...result, outputs: existsSync(output) ? Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map((l) => l.split('='))) : {},
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
}

test('actual gate forces PR checkout/build and no publish/latest or release query despite hostile release/dispatch fields', () => {
  const got = gate('pull_request', { REF: 'refs/tags/v999', RELEASE_TAG: 'v999', DISPATCH_CONTENT: 'v999', RELEASE_PRERELEASE: 'false', HAS: 'none' });
  expect(got.status).toBe(0); expect(got.calls).toBe('');
  expect(got.outputs).toEqual({ version, content: version, tag: `checkout-${revision}`, revision, build: 'true', publish: 'false', latest: 'false', source: 'checkout' });
});

test('push first chooses current release, then newest stable plugin release, and never publishes', () => {
  const current = gate('push'); expect(current.status).toBe(0);
  expect(current.outputs).toMatchObject({ content: version, source: 'release', publish: 'false', latest: 'false', tag: `${version}-${revision.slice(0, 8)}` });
  expect(current.calls).toContain(`release view v${version}`); expect(current.calls).not.toContain('api ');
  const fallback = gate('push', { HAS: 'none' }); expect(fallback.status).toBe(0);
  expect(fallback.outputs.content).toBe('1.2.3'); expect(fallback.calls).toContain('releases?per_page=30');
  expect(gate('push', { HAS: 'none', NEWEST: '' }).status).not.toBe(0);
});

test('dispatch release selection, ref restrictions, prerelease and refusal behavior are preserved', () => {
  for (const [extra, content, latest] of [
    [{}, '1.2.3', 'true'], [{ DISPATCH_CONTENT: 'v2.3.4' }, '2.3.4', 'true'],
    [{ DISPATCH_CONTENT: '2.3.4', PRE: 'true' }, '2.3.4', 'false'],
    [{ REF: `refs/tags/v${version}`, REF_NAME: `v${version}` }, '1.2.3', 'true'],
  ] as const) {
    const got = gate('workflow_dispatch', extra); expect(got.status).toBe(0);
    expect(got.outputs).toMatchObject({ content, latest, publish: 'true', source: 'release', build: 'true' });
  }
  for (const extra of [{ HAS: 'none' }, { PRE: 'unreadable' }, { NEWEST: '' }, { REF: 'refs/heads/other' }, { REF: 'refs/tags/v0.0.0', REF_NAME: 'v0.0.0' }]) expect(gate('workflow_dispatch', extra).status).not.toBe(0);
});

test('release events retain version binding, no-assets skip, stable/prerelease publication', () => {
  for (const pre of ['false', 'true']) {
    const got = gate('release', { RELEASE_PRERELEASE: pre }); expect(got.status).toBe(0);
    expect(got.outputs).toMatchObject({ content: version, publish: 'true', source: 'release', latest: pre === 'false' ? 'true' : 'false' });
  }
  expect(gate('release', { RELEASE_TAG: 'v0.0.0' }).status).not.toBe(0);
  expect(gate('release', { HAS: 'none' }).outputs).toMatchObject({ build: 'false', publish: 'false', latest: 'false', source: 'release' });
  const unknown = gate('unknown'); expect(unknown.status).not.toBe(0); expect(unknown.calls).toBe('');
});

test('actual pre-load publication guard rejects forged output before any Docker login/push', () => {
  const dir = mkdtempSync(join(tmpdir(), 'publish-guard-test-')); owned.push(dir);
  const log = join(dir, 'docker.log');
  writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho called >> "$DOCKER_LOG"\nexit 1\n'); chmodSync(join(dir, 'docker'), 0o755);
  for (const [event, source] of [['pull_request', 'release'], ['push', 'release'], ['unknown', 'release'], ['release', 'checkout'], ['workflow_dispatch', 'checkout']]) {
    // Run the step itself with -e: a failed guard stops all subsequent commands.
    const guarded = spawnSync('bash', ['-e', '-c', script('Refuse non-release publication before loading artifacts') + '\ndocker login\ndocker push'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOCKER_LOG: `${log}-guarded`, EVENT: event, INPUT_KIND: source },
    });
    expect(guarded.status).not.toBe(0); expect(existsSync(`${log}-guarded`)).toBe(false);
  }
});

test('PR tooling import coverage, frozen setup and source proof precede smoke; published image proof precedes login', () => {
  const pr = workflow.split('  pull_request:\n')[1].split('  push:\n')[0];
  for (const path of ['apps/*-dsh/**', 'package.json', 'bun.lock', 'scripts/server-checkout.ts', 'scripts/release-plugins.ts', 'scripts/marketplace.ts', 'scripts/version.ts']) expect(pr).toContain(`- ${path}`);
  const setup = block('Install locked checkout tooling'); expect(setup).toContain("if: github.event_name == 'pull_request'");
  expect(setup).toContain('run: bun install --frozen-lockfile --ignore-scripts');
  expect(workflow.indexOf(setup)).toBeLessThan(workflow.indexOf(block('Pack committed checkout inputs')));
  expect(workflow.indexOf(block('Prove the installed checkout child and image identity'))).toBeLessThan(workflow.indexOf(block('Smoke')));
  expect(block('Keep the checkout image proof')).toContain("if: always() && github.event_name == 'pull_request'");
  expect(block('Keep the checkout image proof')).toContain('if-no-files-found: error');
  expect(workflow.indexOf(block('Refuse non-release publication before loading artifacts'))).toBeLessThan(workflow.indexOf('uses: actions/download-artifact@'));
  expect(workflow.indexOf(block('Verify the loaded candidate source before login'))).toBeLessThan(workflow.indexOf(block('Log in to the Container registry')));
  for (const name of ['Save the scanned image for the publish job', 'Keep the image']) {
    expect(block(name)).toContain("steps.gate.outputs.source == 'release' && (github.event_name == 'release' || github.event_name == 'workflow_dispatch')");
  }
  const image = workflow.split('\n  image:\n')[1].split('\n  publish:\n')[0];
  expect(image).not.toContain('permissions:'); expect(image).not.toContain('docker login'); expect(image).not.toContain('id-token:');
});

test('push filters and literal publish/record/lane dependency contracts remain unchanged', () => {
  expect(workflow.split('  push:\n')[1].split('  release:\n')[0]).toBe(`    branches: [dev]
    paths:
      - server/**
      - apps/desktop/runtime/package.json
      - apps/desktop/runtime/package-lock.json
      - apps/desktop/runtime/patches/**
      - apps/desktop/scripts/prune-runtime.mjs
      - apps/desktop/scripts/runtime-patches.mjs
      - herdr/scripts/privacy-check.mjs
      - herdr/scripts/privacy-list.json
      - .github/workflows/server-image.yml
`);
  for (const job of ['publish', 'record']) expect(workflow.split(`\n  ${job}:\n`)[1]).toContain("\n    if: needs.image.outputs.publish == 'true'\n");
  expect(workflow).toContain('needs: [image, publish]'); expect(workflow).toContain('needs: [image, record]');
  expect(workflow).toContain("if: needs.image.outputs.publish == 'true' && needs.image.outputs.latest == 'true'");
});
