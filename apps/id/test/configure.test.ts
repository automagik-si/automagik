import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

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

function configure(origin: string, extra: Record<string, string> = {}) {
  return spawnSync('bun', [script], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, ID_WORKER_ORIGIN: origin, ID_DATABASE_ID: databaseId, ...extra },
  });
}

test('a subdomain of automagik.si is configured with PASSKEY_RP_ID automagik.si', async () => {
  const run = configure('https://id.automagik.si');
  expect(run.status, run.stderr).toBe(0);
  const written = await readFile(resolve(dir, 'wrangler.local.toml'), 'utf8');
  expect(written).toContain('BETTER_AUTH_URL = "https://id.automagik.si"');
  expect(written).toContain('PASSKEY_RP_ID = "automagik.si"');
  expect(written).toContain('workers_dev = false');
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

// Admission tickets: the Worker gets Cloud's public keys and issuer, checked here first.
async function admissionKey() {
  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(jwk);
  return { pub: { ...jwk, kid }, secret: { ...(await exportJWK(privateKey)), kid } };
}

test('admission keys and issuer are written for the Worker, public parts only', async () => {
  const { pub } = await admissionKey();
  const run = configure('https://id.automagik.si', {
    ADMISSION_KEYS: JSON.stringify({ keys: [{ ...pub, use: 'sig', key_ops: ['verify'] }] }),
    ADMISSION_ISSUER: 'https://cloud.automagik.si',
  });
  expect(run.status, run.stderr).toBe(0);
  const written = await readFile(resolve(dir, 'wrangler.local.toml'), 'utf8');
  expect(written).toContain('ADMISSION_ISSUER = "https://cloud.automagik.si"');
  const line = written.split('\n').find(entry => entry.startsWith('ADMISSION_KEYS = '))!;
  expect(JSON.parse(JSON.parse(line.slice('ADMISSION_KEYS = '.length)))).toEqual({
    keys: [{ kty: 'OKP', crv: 'Ed25519', x: pub.x, kid: pub.kid, alg: 'EdDSA', use: 'sig' }],
  });
});

test('without admission keys nothing is written for them, and sign-up stays closed', async () => {
  const run = configure('https://id.automagik.si');
  expect(run.status, run.stderr).toBe(0);
  expect(run.stderr).toContain('ADMISSION_KEYS is not set: no account can be created');
  expect(await readFile(resolve(dir, 'wrangler.local.toml'), 'utf8')).not.toContain('ADMISSION_');
});

test('admission settings are validated: a private key, a bad JWKS or issuer, or one without the other', async () => {
  const { pub, secret } = await admissionKey();
  const issuer = 'https://cloud.automagik.si';
  const keys = JSON.stringify({ keys: [pub] });
  for (const [extra, message] of [
    [{ ADMISSION_KEYS: JSON.stringify({ keys: [secret] }), ADMISSION_ISSUER: issuer }, 'no private key'],
    [{ ADMISSION_KEYS: 'not json', ADMISSION_ISSUER: issuer }, 'ADMISSION_KEYS must be a JWKS'],
    [{ ADMISSION_KEYS: JSON.stringify({ keys: [{ ...pub, kid: undefined }] }), ADMISSION_ISSUER: issuer }, 'unique kid'],
    [{ ADMISSION_KEYS: keys, ADMISSION_ISSUER: 'http://cloud.automagik.si' }, 'ADMISSION_ISSUER must be an HTTPS URL'],
    [{ ADMISSION_KEYS: keys }, 'together'],
    [{ ADMISSION_ISSUER: issuer }, 'together'],
  ] as [Record<string, string>, string][]) {
    await rm(resolve(dir, 'wrangler.local.toml'), { force: true });
    const run = configure('https://id.automagik.si', extra);
    expect(run.status, message).not.toBe(0);
    expect(run.stderr, message).toContain(message);
    // The private key never reaches the output.
    expect(run.stdout + run.stderr).not.toContain(secret.d!);
    await expect(stat(resolve(dir, 'wrangler.local.toml'))).rejects.toThrow();
  }
});
