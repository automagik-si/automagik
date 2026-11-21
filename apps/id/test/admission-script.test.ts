import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyAdmission } from '../src/admission';

// The operator's stand-in for Cloud: keygen writes the private key to one file outside any
// checkout and prints only the public JWKS; mint reads the key from the environment only.
const script = resolve('scripts/admission.ts');
const issuer = 'https://cloud.automagik.si';
const origin = 'https://id.automagik.si';
let outside: string;

beforeAll(async () => { outside = await mkdtemp(join(tmpdir(), 'id-admission-')); });
afterAll(async () => { await rm(outside, { recursive: true, force: true }); });

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bun', [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
}

test('keygen writes the private key with mode 0600 and prints only the public JWKS; mint signs a valid ticket', async () => {
  const path = join(outside, 'admission.jwk');
  const made = run(['keygen', path]);
  expect(made.status, made.stderr).toBe(0);
  const secret = JSON.parse(await readFile(path, 'utf8'));
  expect(secret.d).toBeTruthy();
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(made.stdout + made.stderr).not.toContain(secret.d);
  const jwks = JSON.parse(made.stdout);
  expect(jwks.keys).toHaveLength(1);
  expect(jwks.keys[0]).toEqual({ kty: 'OKP', crv: 'Ed25519', x: secret.x, kid: secret.kid, alg: 'EdDSA', use: 'sig' });

  // Never replaces an existing file.
  expect(run(['keygen', path]).status).not.toBe(0);
  expect(JSON.parse(await readFile(path, 'utf8')).d).toBe(secret.d);

  const minted = run(['mint'], {
    ADMISSION_PRIVATE_KEY: JSON.stringify(secret), ADMISSION_ISSUER: issuer, ID_WORKER_ORIGIN: origin,
  });
  expect(minted.status, minted.stderr).toBe(0);
  expect(minted.stdout + minted.stderr).not.toContain(secret.d);
  const ticket = minted.stdout.trim();
  const env = { BETTER_AUTH_URL: origin, ADMISSION_KEYS: made.stdout, ADMISSION_ISSUER: issuer };
  const admission = await verifyAdmission(env, ticket, 'signup');
  expect(admission.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
  expect(admission.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
  // Two tickets never share an id.
  const again = run(['mint'], { ADMISSION_PRIVATE_KEY: JSON.stringify(secret), ADMISSION_ISSUER: issuer, ID_WORKER_ORIGIN: origin });
  expect((await verifyAdmission(env, again.stdout.trim(), 'signup')).jti).not.toBe(admission.jti);
});

test('keygen refuses a path inside a git checkout, also through a symbolic link', async () => {
  const inside = resolve('.wrangler', 'admission-test.jwk');
  await mkdir('.wrangler', { recursive: true });
  const refused = run(['keygen', inside]);
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain('inside a git checkout');
  await expect(stat(inside)).rejects.toThrow();
  const link = join(outside, 'into-checkout');
  await symlink(resolve('.wrangler'), link);
  expect(run(['keygen', join(link, 'admission.jwk')]).status).not.toBe(0);
  await expect(stat(resolve('.wrangler', 'admission.jwk'))).rejects.toThrow();
  // A folder of its own outside any checkout is fine; a missing one is not.
  const other = join(outside, 'checkout');
  await mkdir(join(other, '.git'), { recursive: true });
  expect(run(['keygen', join(other, 'admission.jwk')]).status).not.toBe(0);
  expect(run(['keygen', join(outside, 'missing', 'admission.jwk')]).status).not.toBe(0);
  expect(run(['keygen']).status).not.toBe(0);
});

test('mint takes the key from the environment only and refuses anything else', async () => {
  const path = join(outside, 'mint.jwk');
  const made = run(['keygen', path]);
  expect(made.status, made.stderr).toBe(0);
  const secret = await readFile(path, 'utf8');
  const env = { ADMISSION_ISSUER: issuer, ID_WORKER_ORIGIN: origin };
  for (const [args, extra] of [
    [['mint', secret.trim()], { ...env, ADMISSION_PRIVATE_KEY: secret }],
    [['mint'], env],
    [['mint'], { ...env, ADMISSION_PRIVATE_KEY: made.stdout }],
    [['mint'], { ADMISSION_PRIVATE_KEY: secret, ID_WORKER_ORIGIN: origin }],
    [['mint'], { ADMISSION_PRIVATE_KEY: secret, ADMISSION_ISSUER: issuer, ID_WORKER_ORIGIN: 'http://id.automagik.si' }],
    [['sign'], env],
  ] as [string[], Record<string, string>][]) {
    const refused = run(args, extra);
    expect(refused.status, args.join(' ')).not.toBe(0);
    expect(refused.stdout, args.join(' ')).toBe('');
    expect(refused.stderr).not.toContain(JSON.parse(secret).d);
  }
});
