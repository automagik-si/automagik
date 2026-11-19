import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

// The deployment script writes the passkey site name and refuses a host outside it.
const script = resolve('scripts/configure.ts');
const databaseId = '00000000-0000-4000-8000-000000000000';
let dir: string;

beforeAll(async () => {
  await mkdir('.wrangler', { recursive: true });
  dir = resolve(await mkdtemp('.wrangler/test-configure-'));
  await copyFile('wrangler.toml', resolve(dir, 'wrangler.toml'));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

function configure(origin: string) {
  return spawnSync('bun', [script], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, ID_WORKER_ORIGIN: origin, ID_DATABASE_ID: databaseId },
  });
}

test('a subdomain of automagik.si is configured with PASSKEY_RP_ID automagik.si', async () => {
  const run = configure('https://id.automagik.si');
  expect(run.status, run.stderr).toBe(0);
  const written = await readFile(resolve(dir, 'wrangler.local.toml'), 'utf8');
  expect(written).toContain('BETTER_AUTH_URL = "https://id.automagik.si"');
  expect(written).toContain('PASSKEY_RP_ID = "automagik.si"');
  expect(written).toContain('workers_dev = false');
  expect(written).toContain('crons = ["17 * * * *"]');
  expect((await stat(resolve(dir, 'wrangler.local.toml'))).mode & 0o777).toBe(0o600);
});

test('a host outside automagik.si, a workers.dev one included, is refused', async () => {
  await rm(resolve(dir, 'wrangler.local.toml'), { force: true });
  for (const origin of ['https://automagik-id.placeholder.workers.dev', 'https://notautomagik.si',
    'https://automagik.si.example.com', 'http://id.automagik.si', 'https://id.automagik.si/path']) {
    const run = configure(origin);
    expect(run.status, origin).not.toBe(0);
    expect(run.stderr, origin).toContain('must be an HTTPS origin on automagik.si or a subdomain of it');
  }
  await expect(stat(resolve(dir, 'wrangler.local.toml'))).rejects.toThrow();
});
