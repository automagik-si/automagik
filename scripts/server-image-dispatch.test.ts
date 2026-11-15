import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = (name: string) => Bun.YAML.parse(readFileSync(
  join(import.meta.dir, '..', '.github', 'workflows', name), 'utf8',
)) as any;
const release = workflow('release.yml');
const dispatch = release.jobs['server-image'];
const publish = release.jobs.cut.steps.find((step: any) => step.name === 'Publish the release');

// Execute the workflow's actual shell with a fake gh; no network or workflow dispatch occurs.
function run(script: string, { plugins = false, fail = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'server-image-dispatch-'));
  try {
    mkdirSync(join(dir, 'release'));
    if (plugins) writeFileSync(join(dir, 'release/plugins.json'), '{}');
    const log = join(dir, 'gh.log');
    const output = join(dir, 'output');
    writeFileSync(output, '');
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\nexit "$GH_EXIT"\n');
    chmodSync(join(dir, 'gh'), 0o755);
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: dir, encoding: 'utf8',
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_LOG: log, GH_EXIT: fail ? '1' : '0',
        VERSION: '9.9.9', GITHUB_REPOSITORY: 'owner/repo', GITHUB_OUTPUT: output,
        GITHUB_SERVER_URL: 'https://github.com', GITHUB_STEP_SUMMARY: output,
        CONTENT: '9.9.9', GHCR: 'ghcr.io/owner/image', DIGEST: 'sha256:proof',
      },
    });
    return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n'), output: readFileSync(output, 'utf8') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('stable releases dispatch their server image', () => {
  test('the job exists after only the cut, with only actions: write', () => {
    expect(dispatch).toBeDefined();
    expect(dispatch.needs).toBe('cut');
    expect(dispatch.permissions).toEqual({ actions: 'write' });
    expect(dispatch.env).toEqual({ GH_TOKEN: '${{ github.token }}', VERSION: '${{ needs.cut.outputs.version }}' });
    expect(dispatch.steps).toHaveLength(1);
    expect(dispatch.steps[0].uses).toBeUndefined();
  });

  test('no cut, a prerelease, or a release without plugins.json skips the job', () => {
    expect(dispatch.if).toBe("needs.cut.outputs.version != '' && needs.cut.outputs.plugins == 'true' && inputs.prerelease != true");
  });

  test('the cut reports plugins.json only after successfully publishing that asset', () => {
    expect(publish.id).toBe('publish');
    expect(release.jobs.cut.outputs.plugins).toBe('${{ steps.publish.outputs.plugins }}');
    // Keep the asset list, upload and output together; earlier code only sets notes and flags.
    const script = `flags=()\nnotes=fixture\n${publish.run.slice(publish.run.indexOf('shopt -s nullglob'))}`;
    for (const plugins of [false, true]) {
      const result = run(script, { plugins });
      expect(result.status).toBe(0);
      expect(result.calls[0].includes('release/plugins.json')).toBe(plugins);
      expect(result.output).toBe(plugins ? 'plugins=true\n' : '');
    }
    const failed = run(script, { plugins: true, fail: true });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toBe('');
  });

  test('dispatches the exact release tag and content without waiting for the image', () => {
    const result = run(dispatch.steps[0].run);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(['workflow run server-image.yml --repo owner/repo --ref v9.9.9 -f content=v9.9.9']);
  });

  test('a failed dispatch only warns, and no other lane depends on it', () => {
    const result = run(dispatch.steps[0].run, { fail: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::');
    expect(result.stdout).toContain('v9.9.9');
    expect(dispatch['continue-on-error']).toBe(true);
    expect(dispatch['timeout-minutes']).toBe(5);
    expect(dispatch.concurrency).toBeUndefined();
    for (const job of Object.values(release.jobs) as any[]) {
      expect([job.needs].flat()).not.toContain('server-image');
    }
  });

  test('the Follow Omni caller permits the reusable release to dispatch', () => {
    const caller = Object.values(workflow('follow-omni.yml').jobs).find(
      (job: any) => job.uses === './.github/workflows/release.yml',
    ) as any;
    expect(caller.permissions.actions).toBe('write');
  });

  test('the image record summary prints its pushed digest and a direct asset link', () => {
    const record = workflow('server-image.yml').jobs.record;
    const step = record.steps.find((step: any) => step.name === 'Read the record back from the release');
    // Run the real summary block after a fake gh, without downloading or checking an image.
    const result = run(`gh fixture\n${step.run.slice(step.run.indexOf('{\n'))}`);
    expect(result.status).toBe(0);
    expect(result.output).toContain('ghcr.io/owner/image@sha256:proof');
    expect(result.output).toContain('[server-image.json](https://github.com/owner/repo/releases/download/v9.9.9/server-image.json)');
  });
});
